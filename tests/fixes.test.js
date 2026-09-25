"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildFixSql, manualList } = require("../src/fixes");

const finding = (id, productId, type, ingredientIds) => ({
  id, product_id: productId, issue_type: type, ingredient_ids: ingredientIds, evidence: "Kanıt", suggestion: "Öneri", product_name: `Ürün ${productId}`,
});

test("approved duplicate and extra ingredients become one transaction with score recalculation", () => {
  const { sql, applied, skipped, manual } = buildFixSql(
    [
      finding(1, 10, "duplicate_ingredient", [206, 2928]),
      finding(2, 10, "extra_ingredient", [1846]),
      finding(3, 20, "duplicate_ingredient", [5, 6]),
      finding(4, 30, "duplicate_ingredient", [7, 8]),
      finding(5, 40, "nutrition_implausible", []),
    ],
    new Map([
      [10, new Set([206, 2928, 1846])],
      [20, new Set([6])],
      [30, new Set([7])],
    ]),
  );

  assert.deepEqual(applied.map((item) => item.id), [1, 2]);
  assert.deepEqual(skipped.map((item) => [item.finding.id, item.reason]), [
    [3, "ingredient 5 to keep is no longer linked"],
    [4, "the links to remove are already gone"],
  ]);
  assert.deepEqual(manual.map((item) => item.id), [5]);

  assert.match(sql, /^-- Generated[\s\S]*\nBEGIN;\n[\s\S]*\nCOMMIT;\n$/);
  assert.match(sql, /DELETE FROM public\.product_ingredients WHERE product_id = 10 AND ingredients_id IN \(2928\);/);
  assert.match(sql, /DELETE FROM public\.product_ingredients WHERE product_id = 10 AND ingredients_id IN \(1846\);/);
  assert.match(sql, /keep_link\.product_id = 10 AND keep_link\.ingredients_id = 206 AND keep_link\.percentage IS NULL/);
  assert.match(sql, /INSERT INTO public\.product_allergens \(product_id, ingredient_id, is_trace\)\nSELECT product_id, 206/);
  assert.doesNotMatch(sql, /product_id = 20 AND ingredients_id/);
  assert.equal(sql.match(/calculate_product_score_new\(10\)/g).length, 1, "each product is rescored once");
  assert.match(sql, /SET status = 'applied'\nWHERE status = 'approved' AND id IN \(1, 2\);/);
});

test("findings to fix by hand become one readable line each", () => {
  const list = manualList([{ ...finding(5, 40, "nutrition_inconsistent", []), brand_name: "Sütaş" }]);
  assert.equal(list, "Düzelttikten sonra bulgunun status alanını applied yap.\n#5 · ürün 40 Ürün 40 (Sütaş) · nutrition_inconsistent: Kanıt → Öneri");
  assert.equal(manualList([]), "");
});

test("an export with nothing to apply is still a valid empty transaction", () => {
  const { sql, applied } = buildFixSql([], new Map());
  assert.equal(applied.length, 0);
  assert.doesNotMatch(sql, /DELETE|UPDATE|calculate_product_score_new/);
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
});
