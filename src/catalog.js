"use strict";

const crypto = require("node:crypto");

const NUTRITION_FIELDS = ["energy_kj", "carbohydrate_g", "sugar_g", "fat_g", "saturates_g", "proteins_g", "fibres_g", "salt_g"];

const QUERIES = {
  products: `SELECT id, name, brand_id, category_new_id, ingredients, ${NUTRITION_FIELDS.join(", ")} FROM public.products ORDER BY id`,
  brands: "SELECT id, name FROM public.brands",
  categories: "SELECT id, parent_id, name_tr FROM public.categories_new",
  ingredients: "SELECT id, name FROM public.ingredients",
  links: "SELECT product_id, ingredients_id FROM public.product_ingredients ORDER BY product_id, id",
  state: "SELECT product_id, data_hash FROM ai_jobs.product_audit_state",
};

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function categoryPath(categoryId, categoriesById) {
  const path = [];
  const seen = new Set();
  let current = categoriesById.get(Number(categoryId));
  while (current && !seen.has(current.id) && path.length < 8) {
    seen.add(current.id);
    path.unshift(current.name_tr);
    current = categoriesById.get(Number(current.parent_id));
  }
  return path.filter(Boolean);
}

// The exact record sent to the model. Nutrition null means "not on the label".
function buildProductRecords(tables) {
  const brands = new Map(tables.brands.map((row) => [Number(row.id), row.name]));
  const categories = new Map(tables.categories.map((row) => [Number(row.id), { ...row, id: Number(row.id) }]));
  const ingredients = new Map(tables.ingredients.map((row) => [Number(row.id), row.name]));
  const linksByProduct = new Map();
  for (const link of tables.links) {
    const productId = Number(link.product_id);
    if (!linksByProduct.has(productId)) linksByProduct.set(productId, []);
    linksByProduct.get(productId).push(Number(link.ingredients_id));
  }
  return tables.products.map((product) => {
    const id = Number(product.id);
    return {
      product_id: id,
      name: product.name || "",
      brand: brands.get(Number(product.brand_id)) || "",
      category: categoryPath(product.category_new_id, categories),
      ingredients_text: product.ingredients || null,
      linked_ingredients: (linksByProduct.get(id) || []).map((ingredientId) => ({ id: ingredientId, name: ingredients.get(ingredientId) || "" })),
      nutrition_per_100: Object.fromEntries(NUTRITION_FIELDS.map((field) => [field, toNumber(product[field])])),
    };
  });
}

function recordHash(record) {
  return crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

// Never-audited products first, then products whose data changed; newest first in each group.
// fromId/toId limit the selection to an inclusive product id range; force also selects
// unchanged products (after the others) so a range can be audited again.
function selectProductsToAudit(records, auditedHashes, limit, { fromId = null, toId = null, force = false } = {}) {
  const fresh = [];
  const changed = [];
  const unchanged = [];
  for (const record of records) {
    if (fromId !== null && record.product_id < fromId) continue;
    if (toId !== null && record.product_id > toId) continue;
    const hash = recordHash(record);
    const previous = auditedHashes.get(record.product_id);
    if (previous === hash) {
      if (force) unchanged.push({ record, hash });
      continue;
    }
    (previous === undefined ? fresh : changed).push({ record, hash });
  }
  const newestFirst = (left, right) => right.record.product_id - left.record.product_id;
  return [...fresh.sort(newestFirst), ...changed.sort(newestFirst), ...unchanged.sort(newestFirst)].slice(0, limit);
}

// withState: false skips ai_jobs (dry runs work before the audit tables exist).
async function loadCatalog(client, { withState = true } = {}) {
  const tables = { state: [] };
  for (const [name, sql] of Object.entries(QUERIES)) {
    if (name === "state" && !withState) continue;
    tables[name] = (await client.query(sql)).rows;
  }
  return {
    records: buildProductRecords(tables),
    auditedHashes: new Map(tables.state.map((row) => [Number(row.product_id), row.data_hash])),
  };
}

module.exports = { NUTRITION_FIELDS, buildProductRecords, categoryPath, loadCatalog, recordHash, selectProductsToAudit };
