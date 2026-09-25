#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { Client } = require("pg");
const { auditBatches, buildBatches, continueDecision } = require("../src/audit");
const { loadCatalog, selectProductsToAudit } = require("../src/catalog");
const { loadConfig } = require("../src/config");
const { createGeminiClient } = require("../src/gemini");

function parseArgs(args) {
  const positiveInteger = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0) return null;
    const value = Number(args[index + 1]);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`);
    return value;
  };
  const options = {
    limit: positiveInteger("--limit"),
    fromId: positiveInteger("--from-id"),
    toId: positiveInteger("--to-id"),
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
    untilDone: args.includes("--until-done"),
  };
  if (options.fromId !== null && options.toId !== null && options.fromId > options.toId) {
    throw new Error("--from-id must not be greater than --to-id");
  }
  // A forced product stays selectable after its audit, so a forced chain would never end.
  if (options.untilDone && (options.force || options.dryRun)) {
    throw new Error("--until-done cannot be combined with --force or --dry-run");
  }
  return options;
}

async function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function describeRange({ fromId, toId, force }) {
  if (fromId === null && toId === null) return "";
  return ` in id range ${fromId ?? "start"}–${toId ?? "end"}${force ? " (force: unchanged products included)" : ""}`;
}

async function writeStepSummary(summary, { dryRun, fromId, toId, force, remaining, untilDone, next }) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const range = fromId === null && toId === null
    ? ""
    : `- Ürün ID aralığı: ${fromId ?? "baştan"} – ${toId ?? "sona"}${force ? " (değişmemiş ürünler de yeniden denetlendi)" : ""}`;
  const lines = [
    range,
    `- Denetlenen ürün: ${summary.audited}`,
    `- Bulgu: ${summary.findings}`,
    `- Atlanan ürün (sonraki çalışmada tekrar denenecek): ${summary.skipped}`,
    `- Başarısız istek grubu: ${summary.failedBatches}`,
    summary.fallbackBatches ? `- Yedek modelin cevapladığı grup: ${summary.fallbackBatches}` : "",
    summary.stoppedEarly ? `- Erken durdu: ${summary.stoppedEarly}` : "",
    remaining === null ? "" : `- Denetlenmeyi bekleyen ürün: ${remaining}`,
    untilDone ? `- Zincir: ${next.continue ? `sonraki çalışma başlatıldı${next.cooldown ? " (Gemini hataları nedeniyle 5 dakika sonra)" : ""}` : `durdu (${next.reason})`}` : "",
  ].filter(Boolean);
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, [
    dryRun ? "## Ürün denetimi (deneme, veritabanına yazılmadı)" : "## Ürün denetimi", "", ...lines, "",
  ].join("\n"));
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const config = loadConfig(root);
  if (!config.databaseUrl) throw new Error("SUPABASE_DB_URL is required");
  const { limit, fromId, toId, force, dryRun, untilDone } = parseArgs(process.argv.slice(2));
  const gemini = createGeminiClient(config.gemini);
  const template = await fs.readFile(path.join(root, "prompts", "audit-products.txt"), "utf8");

  const client = new Client({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // A dry run reads inside a read-only transaction, needs no ai_jobs tables and writes
    // findings only to output/dry-run.json.
    if (dryRun) await client.query("BEGIN READ ONLY");
    const { records, auditedHashes, ingredientUsage } = await loadCatalog(client, { withState: !dryRun });
    // In an until-done chain the time budget, not the daily limit, ends each run.
    const defaultLimit = dryRun ? 20 : untilDone ? Infinity : config.audit.dailyLimit;
    const pending = selectProductsToAudit(records, auditedHashes, Infinity, { fromId, toId }).length;
    const selected = selectProductsToAudit(records, auditedHashes, limit ?? defaultLimit, { fromId, toId, force });
    const batches = buildBatches(selected, config.audit.batchSize, config.audit.maxBatchChars);
    console.log(`[audit]${dryRun ? " DRY RUN" : ""} ${records.length} products, ${auditedHashes.size} audited before, ${selected.length} selected${describeRange({ fromId, toId, force })} in ${batches.length} batch(es) with ${gemini.model}${gemini.fallbackModel ? ` (fallback ${gemini.fallbackModel})` : ""}`);

    const dryResults = [];
    const summary = await auditBatches({
      client, gemini, batches, template, maxMinutes: config.audit.maxMinutes, concurrency: gemini.slots, ingredientUsage,
      ...(dryRun ? { save: async (result) => { dryResults.push(result); } } : {}),
    });
    if (dryRun) await client.query("ROLLBACK");
    // GitHub Actions logs of a public repository are public, so findings are shown only locally.
    if (dryRun && process.env.GITHUB_ACTIONS === "true") {
      console.log("[audit] dry run on GitHub: findings are not printed; run it locally to see them");
    } else if (dryRun) {
      const byId = new Map(selected.map((item) => [item.record.product_id, item.record]));
      await fs.mkdir(path.join(root, "output"), { recursive: true });
      await fs.writeFile(path.join(root, "output", "dry-run.json"), `${JSON.stringify(dryResults.map((result) => ({
        product_id: result.productId, name: byId.get(result.productId)?.name, findings: result.findings,
      })), null, 2)}\n`, "utf8");
      for (const result of dryResults.filter((item) => item.findings.length)) {
        console.log(`\n#${result.productId} ${byId.get(result.productId)?.name}`);
        for (const finding of result.findings) {
          console.log(`  - ${finding.type} [${finding.severity}] ${finding.evidence}\n    → ${finding.onApprove}`);
        }
      }
    }
    const remaining = dryRun || force ? null : Math.max(pending - summary.audited, 0);
    const next = untilDone ? continueDecision(summary, remaining) : { continue: false, cooldown: false, reason: "" };
    console.log(`\n[audit] done: ${JSON.stringify({ ...summary, remaining })}${untilDone ? `; chain: ${next.continue ? "next run dispatched" : `stops (${next.reason})`}` : ""}`);
    await writeStepSummary(summary, { dryRun, fromId, toId, force, remaining, untilDone, next });
    await writeOutput("continue", next.continue);
    await writeOutput("cooldown", Boolean(next.cooldown));
    if (selected.length && !summary.audited) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
