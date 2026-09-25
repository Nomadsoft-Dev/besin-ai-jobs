"use strict";

const crypto = require("node:crypto");

const ISSUE_TYPES = [
  "duplicate_ingredient", "missing_ingredient", "extra_ingredient",
  "nutrition_inconsistent", "nutrition_implausible", "bad_text", "other",
];
const SEVERITIES = ["high", "medium", "low"];
// Issue types that export-fixes turns into SQL; the others are fixed by hand.
const AUTO_FIX_TYPES = ["duplicate_ingredient", "extra_ingredient"];
const MAX_TEXT = 300;
const STOPPED_BY_FAILURES = "3 consecutive failed batches";
const MAX_PRODUCT_DATA = 2000;
const NUTRITION_LABELS = [
  ["energy_kj", "Enerji", "kJ"], ["carbohydrate_g", "Karbonhidrat", "g"], ["sugar_g", "şeker", "g"],
  ["fat_g", "Yağ", "g"], ["saturates_g", "doymuş", "g"], ["proteins_g", "Protein", "g"],
  ["fibres_g", "Lif", "g"], ["salt_g", "Tuz", "g"],
];

const AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          product_id: { type: "integer" },
          issues: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string", enum: ISSUE_TYPES },
                severity: { type: "string", enum: SEVERITIES },
                ingredient_ids: { type: "array", items: { type: "integer" } },
                evidence: { type: "string" },
                suggestion: { type: "string" },
              },
              required: ["type", "severity", "ingredient_ids", "evidence", "suggestion"],
            },
          },
        },
        required: ["product_id", "issues"],
      },
    },
  },
  required: ["items"],
};

// Splits products into batches limited by count and by prompt size.
function buildBatches(items, batchSize, maxChars) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const itemSize = JSON.stringify(item.record).length;
    if (current.length && (current.length >= batchSize || size + itemSize > maxChars)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length) batches.push(current);
  return batches;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

// The product data a finding type is about. Its hash is part of the fingerprint, so a rejected
// finding stays rejected while that data is unchanged, and a new finding opens once it changes.
// A duplicate is about the ingredients themselves, which its ids already identify.
function findingSubject(type, record) {
  switch (type) {
    case "duplicate_ingredient": return null;
    case "extra_ingredient":
    case "bad_text": return record.ingredients_text;
    case "missing_ingredient": return [record.ingredients_text, record.linked_ingredients.map((ingredient) => ingredient.id)];
    case "nutrition_inconsistent":
    case "nutrition_implausible": return record.nutrition_per_100;
    default: return [record.name, record.brand, record.category];
  }
}

function fingerprint(productId, type, ingredientIds, subject = null) {
  const key = `${productId}:${type}:${[...ingredientIds].sort((a, b) => a - b).join(",")}`;
  if (subject === null) return key;
  return `${key}:${crypto.createHash("sha256").update(JSON.stringify(subject)).digest("hex").slice(0, 12)}`;
}

function formatNumber(value) {
  return value === null || value === undefined ? "—" : String(value).replace(".", ",");
}

function ingredientLabel(record, id) {
  const name = record.linked_ingredients.find((ingredient) => ingredient.id === id)?.name || "?";
  return `"${name}" (#${id})`;
}

// Plain-language result of approving the finding, shown next to it in the Table Editor.
function describeApproval(type, ids, record) {
  const labels = (list) => list.map((id) => ingredientLabel(record, id)).join(", ");
  if (type === "duplicate_ingredient") {
    const [keep, ...remove] = ids;
    return `SQL ile düzelir: ${labels(remove)} bağlantısı silinir, ${ingredientLabel(record, keep)} kalır.`;
  }
  if (type === "extra_ingredient") return `SQL ile düzelir: ${labels(ids)} bağlantısı silinir.`;
  // A missing finding with ids points at a function name ("Koruyucu") linked in place of the
  // specific additives the text names.
  if (type === "missing_ingredient" && ids.length) {
    return `Elle düzeltilir: ${labels(ids)} bağlantısı kaldırılıp metindeki maddeler ayrı ayrı bağlanmalı; SQL üretilmez.`;
  }
  const related = ids.length ? ` İlgili bileşenler: ${labels(ids)}.` : "";
  return `Elle düzeltilir: onaylarsan elle düzeltme listesine eklenir, SQL üretilmez.${related}`;
}

// The part of the product record the finding is about, readable without opening other tables.
function describeProductData(type, record) {
  let text;
  if (type.startsWith("nutrition_")) {
    const value = (field) => record.nutrition_per_100[field];
    const part = ([field, label, unit]) => `${label} ${formatNumber(value(field))}${value(field) === null || value(field) === undefined ? "" : ` ${unit}`}`;
    const [energy, carbohydrate, sugar, fat, saturates, protein, fibre, salt] = NUTRITION_LABELS.map(part);
    text = `100 g/ml: ${energy} · ${carbohydrate} (${sugar}) · ${fat} (${saturates}) · ${protein} · ${fibre} · ${salt}`;
  } else if (type === "other") {
    text = `Ad: ${record.name} | Marka: ${record.brand || "—"} | Kategori: ${record.category.join(" > ") || "—"}`;
  } else {
    text = `İçindekiler: ${record.ingredients_text || "(yok)"}`;
    if (type !== "bad_text") {
      const linked = record.linked_ingredients.map((ingredient) => `${ingredient.name} (#${ingredient.id})`).join(", ");
      text += ` | Bağlı bileşenler: ${linked || "(yok)"}`;
    }
  }
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_PRODUCT_DATA ? `${clean.slice(0, MAX_PRODUCT_DATA - 1)}…` : clean;
}

// The record a duplicate keeps: the one linked to the most products in the catalog (then the
// lower id), so every product keeps the same record whatever order the model used.
function keepMostUsedFirst(ids, ingredientUsage) {
  return [...ids].sort((left, right) => (ingredientUsage.get(right) || 0) - (ingredientUsage.get(left) || 0) || left - right);
}

// Keeps only findings the product record can support. Products the model skipped or
// returned twice are left out so they are audited again on the next run.
// ingredientUsage: ingredient id -> number of products linking it.
function validateAuditOutput(output, records, ingredientUsage = new Map()) {
  const byId = new Map(records.map((record) => [record.product_id, record]));
  const items = Array.isArray(output?.items) ? output.items : [];
  const counts = new Map();
  for (const item of items) counts.set(Number(item?.product_id), (counts.get(Number(item?.product_id)) || 0) + 1);

  const audited = new Map();
  for (const item of items) {
    const productId = Number(item?.product_id);
    const record = byId.get(productId);
    if (!record || counts.get(productId) !== 1) continue;
    const linkedIds = new Set(record.linked_ingredients.map((ingredient) => ingredient.id));
    const findings = new Map();
    for (const issue of Array.isArray(item.issues) ? item.issues : []) {
      if (!ISSUE_TYPES.includes(issue?.type) || !SEVERITIES.includes(issue?.severity)) continue;
      let ids = [...new Set((Array.isArray(issue.ingredient_ids) ? issue.ingredient_ids : []).map(Number))];
      if (ids.some((id) => !linkedIds.has(id))) continue;
      if (issue.type === "duplicate_ingredient") ids = keepMostUsedFirst(ids, ingredientUsage);
      if (issue.type === "duplicate_ingredient" && ids.length < 2) continue;
      if (issue.type === "extra_ingredient" && ids.length < 1) continue;
      const evidence = cleanText(issue.evidence);
      const suggestion = cleanText(issue.suggestion);
      if (!evidence) continue;
      // Issues without ingredient ids share one row per type; merge their evidence.
      const idsForKey = AUTO_FIX_TYPES.includes(issue.type) ? ids : [];
      const key = fingerprint(productId, issue.type, idsForKey, findingSubject(issue.type, record));
      const existing = findings.get(key);
      if (existing) {
        existing.evidence = cleanText(`${existing.evidence} / ${evidence}`);
        existing.ingredientIds = [...new Set([...existing.ingredientIds, ...ids])];
        if (SEVERITIES.indexOf(issue.severity) < SEVERITIES.indexOf(existing.severity)) existing.severity = issue.severity;
        continue;
      }
      findings.set(key, { productId, type: issue.type, severity: issue.severity, ingredientIds: ids, evidence, suggestion, fingerprint: key });
    }
    audited.set(productId, [...findings.values()].map((finding) => ({
      ...finding,
      productName: record.name,
      brandName: record.brand,
      onApprove: describeApproval(finding.type, finding.ingredientIds, record),
      productData: describeProductData(finding.type, record),
    })));
  }
  return audited;
}

async function saveAuditResult(client, { productId, hash, model, findings }) {
  await client.query("BEGIN");
  try {
    for (const finding of findings) {
      // A re-found issue updates its open, resolved or applied row and opens it again; a
      // rejected or approved row keeps the admin's decision. The fingerprint changes when the
      // data the issue is about changes, so such an issue opens a new row instead.
      await client.query(
        `INSERT INTO ai_jobs.product_audit_findings
           (product_id, product_name, brand_name, issue_type, severity, evidence, suggestion, on_approve, product_data,
            ingredient_ids, fingerprint, data_hash, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (fingerprint) DO UPDATE SET
           product_name = EXCLUDED.product_name, brand_name = EXCLUDED.brand_name, severity = EXCLUDED.severity,
           evidence = EXCLUDED.evidence, suggestion = EXCLUDED.suggestion, on_approve = EXCLUDED.on_approve,
           product_data = EXCLUDED.product_data, ingredient_ids = EXCLUDED.ingredient_ids,
           data_hash = EXCLUDED.data_hash, model = EXCLUDED.model, status = 'open'
         WHERE ai_jobs.product_audit_findings.status IN ('open', 'resolved', 'applied')`,
        [
          productId, finding.productName, finding.brandName, finding.type, finding.severity, finding.evidence,
          finding.suggestion, finding.onApprove, finding.productData, finding.ingredientIds, finding.fingerprint, hash, model,
        ],
      );
    }
    await client.query(
      `UPDATE ai_jobs.product_audit_findings SET status = 'resolved'
       WHERE product_id = $1 AND status = 'open' AND NOT (fingerprint = ANY($2::text[]))`,
      [productId, findings.map((finding) => finding.fingerprint)],
    );
    await client.query(
      `INSERT INTO ai_jobs.product_audit_state (product_id, data_hash, model, finding_count, audited_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (product_id) DO UPDATE SET
         data_hash = EXCLUDED.data_hash, model = EXCLUDED.model, finding_count = EXCLUDED.finding_count, audited_at = now()`,
      [productId, hash, model, findings.length],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

// Audits selected products batch by batch and saves each batch as soon as it is validated,
// so a stopped run keeps its progress. Stops at the time budget or after repeated failures.
// concurrency lets each API key carry its own request (the Gemini client enforces the per-key
// pace). Saves are serialized because they share one database connection and transaction.
async function auditBatches({
  client, gemini, batches, template, maxMinutes, concurrency = 1, ingredientUsage = new Map(), now = Date.now, log = console.log,
  save = (result) => saveAuditResult(client, result),
}) {
  const startedAt = now();
  // No batch starts after the deadline and a started batch is not retried past it, so the run
  // ends at most one request timeout after maxMinutes.
  const deadline = startedAt + maxMinutes * 60000;
  const summary ={ batches: 0, failedBatches: 0, audited: 0, skipped: 0, findings: 0, stoppedEarly: "" };
  let consecutiveFailures = 0;
  let cursor = 0;
  let saving = Promise.resolve();
  const serialized = (task) => {
    const run = saving.then(task);
    saving = run.catch(() => {});
    return run;
  };

  async function auditOne(index) {
    const batch = batches[index];
    const records = batch.map((item) => item.record);
    const prompt = template.replace("{{products}}", JSON.stringify(records));
    try {
      const { output, usage } = await gemini.generateJson(prompt, AUDIT_SCHEMA, { deadline });
      const audited = validateAuditOutput(output, records, ingredientUsage);
      await serialized(async () => {
        for (const item of batch) {
          const findings = audited.get(item.record.product_id);
          if (!findings) {
            summary.skipped += 1;
            continue;
          }
          await save({ productId: item.record.product_id, hash: item.hash, model: gemini.model, findings });
          summary.audited += 1;
          summary.findings += findings.length;
        }
      });
      summary.batches += 1;
      consecutiveFailures = 0;
      log(`[audit] batch ${index + 1}/${batches.length}: ${audited.size}/${batch.length} products, tokens in=${usage?.promptTokenCount ?? "?"}`);
    } catch (error) {
      summary.failedBatches += 1;
      summary.skipped += batch.length;
      consecutiveFailures += 1;
      log(`[audit] batch ${index + 1}/${batches.length} failed: ${String(error.message).slice(0, 200)}`);
      if (consecutiveFailures >= 3 && !summary.stoppedEarly) summary.stoppedEarly = STOPPED_BY_FAILURES;
    }
  }

  async function worker() {
    while (cursor < batches.length && !summary.stoppedEarly) {
      if (now() > deadline) {
        summary.stoppedEarly = "time budget reached";
        break;
      }
      await auditOne(cursor++);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker));
  await saving;
  return summary;
}

// Whether an until-done chain starts another run. It continues while runs make progress, also
// when the API kept failing (cooldown: the next run waits first, as Gemma overloads come and go).
// It stops when nothing is left or a run audited nothing (the API is down, or only products the
// model keeps skipping are left); the next scheduled run picks up from there.
function continueDecision(summary, remaining) {
  if (!remaining) return { continue: false, cooldown: false, reason: "denetlenecek ürün kalmadı" };
  if (!summary.audited) return { continue: false, cooldown: false, reason: "bu çalışmada hiç ürün denetlenemedi" };
  return { continue: true, cooldown: summary.stoppedEarly === STOPPED_BY_FAILURES, reason: "" };
}

module.exports = {
  AUDIT_SCHEMA, AUTO_FIX_TYPES, ISSUE_TYPES, auditBatches, buildBatches, continueDecision, fingerprint, saveAuditResult,
  validateAuditOutput,
};
