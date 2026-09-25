"use strict";

const { setTimeout: sleep } = require("node:timers/promises");

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const BACKOFF_MS = [15000, 30000, 60000, 120000];

class GeminiError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.retryable = retryable;
  }
}

// Joins the answer's text parts and skips thought parts.
function responseText(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts)
    ? parts.filter((part) => part?.thought !== true && typeof part?.text === "string").map((part) => part.text).join("").trim()
    : "";
}

function retryDelayMs(message, attempt) {
  const hinted = String(message || "").match(/retry in ([\d.]+)s/i);
  if (hinted) return Math.ceil(Number(hinted[1]) * 1000) + 2000;
  return BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
}

// Sends JSON-schema requests. Each API key carries at most keyConcurrency requests at a time and
// starts a new one only keyIntervalMs after its previous start, so a key stays within its
// per-minute token budget; with several keys, concurrent callers use them in parallel.
function createGeminiClient(options) {
  const { apiKeys, model, attempts = 5, timeoutMs = 300000, keyIntervalMs = 65000, keyConcurrency = 1 } = options;
  if (!apiKeys?.length) throw new Error("GEMINI_API_KEY (or GEMINI_API_KEY_2) is required");
  if (!model) throw new Error("A model is required");
  const doFetch = options.fetch || fetch;
  const wait = options.sleep || sleep;
  const now = options.now || Date.now;
  const nextAllowedAt = apiKeys.map(() => 0);
  const inFlight = apiKeys.map(() => 0);
  const waiting = [];

  async function acquireKey() {
    for (;;) {
      const free = apiKeys.map((_, index) => index).filter((index) => inFlight[index] < keyConcurrency);
      if (free.length) {
        const index = free.reduce((best, candidate) => (nextAllowedAt[candidate] < nextAllowedAt[best] ? candidate : best));
        // Reserve the slot and the start time before waiting, so callers sharing a key are spaced.
        inFlight[index] += 1;
        const startAt = Math.max(now(), nextAllowedAt[index]);
        nextAllowedAt[index] = startAt + keyIntervalMs;
        const delay = startAt - now();
        if (delay > 0) await wait(delay);
        return index;
      }
      await new Promise((resolve) => waiting.push(resolve));
    }
  }

  function releaseKey(index) {
    inFlight[index] -= 1;
    waiting.shift()?.();
  }

  async function sendOnce(prompt, schema) {
    const keyIndex = await acquireKey();
    try {
      return await sendWithKey(apiKeys[keyIndex], prompt, schema);
    } finally {
      releaseKey(keyIndex);
    }
  }

  async function sendWithKey(key, prompt, schema) {
    let response;
    try {
      response = await doFetch(`${BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: schema },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GeminiError(`Gemini request failed: ${error.message}`, { retryable: true });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = text;
      try { message = JSON.parse(text)?.error?.message || text; } catch {}
      throw new GeminiError(`Gemini HTTP ${response.status}: ${String(message).slice(0, 300)}`, {
        status: response.status,
        retryable: RETRYABLE_STATUS.has(response.status),
      });
    }
    const body = await response.json();
    const content = responseText(body);
    if (!content) {
      const reason = body?.promptFeedback?.blockReason || body?.candidates?.[0]?.finishReason || "empty response";
      throw new GeminiError(`Gemini returned no content: ${reason}`, { retryable: true });
    }
    try {
      return { output: JSON.parse(content), usage: body.usageMetadata || null };
    } catch {
      throw new GeminiError("Gemini returned invalid JSON", { retryable: true });
    }
  }

  // deadline (epoch ms, optional): no retry starts after it.
  async function generateJson(prompt, schema, { deadline = Infinity } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await sendOnce(prompt, schema);
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === attempts) break;
        const delay = retryDelayMs(error.message, attempt);
        if (now() + delay >= deadline) {
          lastError.message += " (time budget reached; not retried)";
          break;
        }
        console.warn(`[gemini] ${model} attempt ${attempt}/${attempts} failed: ${error.message.slice(0, 160)}; retrying in ${Math.round(delay / 1000)}s`);
        await wait(delay);
      }
    }
    throw lastError;
  }

  // slots: how many requests can be in flight at once across all keys.
  return { model, keyCount: apiKeys.length, slots: apiKeys.length * keyConcurrency, generateJson };
}

module.exports = { GeminiError, createGeminiClient, responseText };
