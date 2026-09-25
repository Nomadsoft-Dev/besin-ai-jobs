"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig(cwd = process.cwd(), env = { ...readEnvFile(path.join(cwd, ".env")), ...process.env }) {
  return {
    databaseUrl: env.SUPABASE_DB_URL || "",
    gemini: {
      apiKeys: [...new Set([env.GEMINI_API_KEY, env.GEMINI_API_KEY_2].map((key) => String(key || "").trim()).filter(Boolean))],
      model: env.AUDIT_MODEL || "gemma-4-31b-it",
      // Optional model that answers when the primary model fails. Off by default: gemma-4-26b-a4b-it
      // answered reliably but reported almost none of the problems 31B finds.
      fallbackModel: ["", "none"].includes(String(env.AUDIT_FALLBACK_MODEL || "")) ? "" : env.AUDIT_FALLBACK_MODEL,
      attempts: number(env.AUDIT_ATTEMPTS, 5),
      timeoutMs: number(env.AUDIT_TIMEOUT_MS, 180000),
      // Gemma allows ~16K input tokens per minute per project (each key is its own project). A
      // batch is ~4K tokens; starting one every 30 s per key uses about half of that. A response
      // takes 1-4 minutes, so two requests per key keep the key busy.
      keyIntervalMs: number(env.AUDIT_KEY_INTERVAL_MS, 30000),
      keyConcurrency: Math.min(Math.max(Math.floor(number(env.AUDIT_KEY_CONCURRENCY, 2)), 1), 4),
    },
    audit: {
      dailyLimit: number(env.AUDIT_DAILY_LIMIT, 1000),
      // GitHub stops a job after 360 minutes; the workflow adds 20 minutes for the last request.
      maxMinutes: Math.min(number(env.AUDIT_MAX_MINUTES, 90), 330),
      batchSize: number(env.AUDIT_BATCH_SIZE, 10),
      // Keeps one request well under the per-minute token limit (~3 characters per token).
      maxBatchChars: number(env.AUDIT_MAX_BATCH_CHARS, 24000),
    },
  };
}

module.exports = { loadConfig, readEnvFile };
