"use strict";

const { setTimeout: sleep } = require("node:timers/promises");

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const BACKOFF_MS = [15000, 30000, 60000, 120000];
// After this many failed requests in a row, the primary model is skipped for PRIMARY_PAUSE_MS.
const PRIMARY_FAILURE_LIMIT = 5;
const PRIMARY_PAUSE_MS = 10 * 60000;

class GeminiError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.retryable = retryable;
  }
}

// Parses the answer, also when the model wrapped the JSON in a code fence or added text around it.
function parseJsonLoose(content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) throw error;
    return JSON.parse(content.slice(start, end + 1));
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
// fallbackModel (optional) answers when the primary model fails: a request tries the primary
// model once and retries with the fallback, and a primary model that keeps failing is skipped
// for a while.
function createGeminiClient(options) {
  const { apiKeys, model, fallbackModel = "", attempts = 5, timeoutMs = 300000, keyIntervalMs = 65000, keyConcurrency = 1 } = options;
  if (!apiKeys?.length) throw new Error("GEMINI_API_KEY (or GEMINI_API_KEY_2) is required");
  if (!model) throw new Error("A model is required");
  const doFetch = options.fetch || fetch;
  const wait = options.sleep || sleep;
  const now = options.now || Date.now;
  const nextAllowedAt = apiKeys.map(() => 0);
  const inFlight = apiKeys.map(() => 0);
  const waiting = [];
  let primaryFailures = 0;
  let primaryPausedUntil = 0;

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

  async function sendOnce(prompt, schema, useModel) {
    const keyIndex = await acquireKey();
    try {
      return await sendWithKey(apiKeys[keyIndex], prompt, schema, useModel);
    } finally {
      releaseKey(keyIndex);
    }
  }

  async function sendWithKey(key, prompt, schema, useModel) {
    let response;
    try {
      response = await doFetch(`${BASE_URL}/models/${encodeURIComponent(useModel)}:generateContent`, {
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
      return { output: parseJsonLoose(content), usage: body.usageMetadata || null };
    } catch {
      const finish = body?.candidates?.[0]?.finishReason || "unknown";
      throw new GeminiError(`Gemini returned invalid JSON (finishReason ${finish}, ${content.length} chars)`, { retryable: true });
    }
  }

  // The first attempt uses the primary model unless it is paused; later attempts use the fallback.
  function modelFor(attempt) {
    if (!fallbackModel) return model;
    return attempt === 1 && now() >= primaryPausedUntil ? model : fallbackModel;
  }

  function recordPrimary(ok) {
    if (ok) {
      primaryFailures = 0;
      return;
    }
    primaryFailures += 1;
    if (fallbackModel && primaryFailures >= PRIMARY_FAILURE_LIMIT) {
      primaryFailures = 0;
      primaryPausedUntil = now() + PRIMARY_PAUSE_MS;
      console.warn(`[gemini] ${model} failed ${PRIMARY_FAILURE_LIMIT} times in a row; using ${fallbackModel} for ${PRIMARY_PAUSE_MS / 60000} minutes`);
    }
  }

  // deadline (epoch ms, optional): no retry starts after it. Returns the model that answered.
  async function generateJson(prompt, schema, { deadline = Infinity } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const useModel = modelFor(attempt);
      try {
        const result = await sendOnce(prompt, schema, useModel);
        if (useModel === model) recordPrimary(true);
        return { ...result, model: useModel };
      } catch (error) {
        lastError = error;
        if (useModel === model && error.retryable) recordPrimary(false);
        if (!error.retryable || attempt === attempts) break;
        // Switching to the fallback model needs no backoff; retrying the same model does.
        const delay = modelFor(attempt + 1) === useModel ? retryDelayMs(error.message, attempt) : 0;
        if (now() + delay >= deadline) {
          lastError.message += " (time budget reached; not retried)";
          break;
        }
        console.warn(`[gemini] ${useModel} attempt ${attempt}/${attempts} failed: ${error.message.slice(0, 160)}; retrying${delay ? ` in ${Math.round(delay / 1000)}s` : ""} with ${modelFor(attempt + 1)}`);
        if (delay) await wait(delay);
      }
    }
    throw lastError;
  }

  // slots: how many requests can be in flight at once across all keys.
  return { model, fallbackModel, keyCount: apiKeys.length, slots: apiKeys.length * keyConcurrency, generateJson };
}

module.exports = { GeminiError, createGeminiClient, parseJsonLoose, responseText };
