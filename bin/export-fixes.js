#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { Client } = require("pg");
const { loadConfig } = require("../src/config");
const { buildFixSql, loadApprovedFindings, manualList } = require("../src/fixes");

function tsvCell(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ");
}

// Writes local copies when run on a computer; on GitHub the result lives only in Supabase,
// because Actions logs and artifacts of a public repository are public.
async function writeLocalFiles(root, result) {
  const outDir = path.join(root, "output");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "fixes.sql"), result.sql, "utf8");
  const manualColumns = ["id", "product_id", "product_name", "brand_name", "issue_type", "evidence", "suggestion", "product_data"];
  await fs.writeFile(
    path.join(outDir, "manual-findings.tsv"),
    [manualColumns.join("\t"), ...result.manual.map((finding) => manualColumns.map((column) => tsvCell(finding[column])).join("\t"))].join("\n") + "\n",
    "utf8",
  );
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const config = loadConfig(root);
  if (!config.databaseUrl) throw new Error("SUPABASE_DB_URL is required");

  const client = new Client({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let result;
  let exportId;
  try {
    const { findings, linksByProduct } = await loadApprovedFindings(client);
    result = buildFixSql(findings, linksByProduct);
    const { rows } = await client.query(
      `INSERT INTO ai_jobs.product_audit_fix_exports (sql_fix_count, skipped_count, manual_count, fix_sql, manual_list)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [result.applied.length, result.skipped.length, result.manual.length, result.sql, manualList(result.manual)],
    );
    exportId = rows[0].id;
  } finally {
    await client.end();
  }
  const local = process.env.GITHUB_ACTIONS !== "true";
  if (local) await writeLocalFiles(root, result);

  const summary = [
    "## Onaylı bulgular",
    "",
    `- SQL ile düzeltilecek: ${result.applied.length}`,
    `- Atlanan (veri değişmiş): ${result.skipped.length}`,
    `- Elle düzeltilecek: ${result.manual.length}`,
    "",
    `Sonuç Supabase'de: Table Editor → ai_jobs → product_audit_fix_exports → id ${exportId}` +
      (local ? " (ayrıca output/fixes.sql ve output/manual-findings.tsv)" : ""),
    "",
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
