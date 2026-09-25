"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { auditBatches, buildBatches, continueDecision, validateAuditOutput } = require("../src/audit");
const { buildProductRecords, recordHash, selectProductsToAudit } = require("../src/catalog");
const { createGeminiClient } = require("../src/gemini");

const record = (id, linkedIds = [1, 2, 3]) => ({
  product_id: id,
  name: `Ürün ${id}`,
  brand: "Marka",
  category: [],
  ingredients_text: "Şeker, Ayçiçek Yağı",
  linked_ingredients: linkedIds.map((ingredientId) => ({ id: ingredientId, name: `Bileşen ${ingredientId}` })),
  nutrition_per_100: {},
});

test("product records keep null nutrition and build the category path", () => {
  const [product] = buildProductRecords({
    products: [{ id: 7, name: "Bisküvi", brand_id: 3, category_new_id: 30, ingredients: "Un", energy_kj: "1800", sugar_g: null }],
    brands: [{ id: 3, name: "Eti" }],
    categories: [{ id: 10, parent_id: null, name_tr: "Atıştırmalık" }, { id: 30, parent_id: 10, name_tr: "Bisküvi" }],
    ingredients: [{ id: 5, name: "Buğday Unu" }],
    links: [{ product_id: 7, ingredients_id: 5 }],
  });
  assert.equal(product.brand, "Eti");
  assert.deepEqual(product.category, ["Atıştırmalık", "Bisküvi"]);
  assert.deepEqual(product.linked_ingredients, [{ id: 5, name: "Buğday Unu" }]);
  assert.equal(product.nutrition_per_100.energy_kj, 1800);
  assert.equal(product.nutrition_per_100.sugar_g, null);
});

test("never-audited products come first, then changed ones; unchanged products are skipped", () => {
  const records = [record(1), record(2), record(3), record(4)];
  const hashes = new Map([[2, recordHash(records[1])], [3, "old-hash"]]);
  const selected = selectProductsToAudit(records, hashes, 10);
  assert.deepEqual(selected.map((item) => item.record.product_id), [4, 1, 3]);
  assert.deepEqual(selectProductsToAudit(records, hashes, 2).map((item) => item.record.product_id), [4, 1]);
});

test("an id range limits the selection and force adds unchanged products after the others", () => {
  const records = [record(1), record(2), record(3), record(4), record(5)];
  const hashes = new Map([[2, recordHash(records[1])], [3, recordHash(records[2])], [4, "old-hash"]]);
  const ids = (options) => selectProductsToAudit(records, hashes, 10, options).map((item) => item.record.product_id);
  assert.deepEqual(ids({ fromId: 2, toId: 4 }), [4], "2 and 3 are unchanged; 1 and 5 are outside the range");
  assert.deepEqual(ids({ fromId: 2, toId: 4, force: true }), [4, 3, 2]);
  assert.deepEqual(ids({ fromId: 4 }), [5, 4]);
  assert.deepEqual(ids({ toId: 2 }), [1]);
});

test("an until-done chain continues only while it makes progress and products are left", () => {
  const run = (overrides) => ({ audited: 100, stoppedEarly: "time budget reached", ...overrides });
  assert.equal(continueDecision(run(), 500).continue, true);
  assert.equal(continueDecision(run(), 0).continue, false);
  assert.equal(continueDecision(run({ stoppedEarly: "3 consecutive failed batches" }), 500).continue, false);
  assert.equal(continueDecision(run({ audited: 0 }), 3).continue, false, "only products the model keeps skipping are left");
});

test("batches respect both the product count and the prompt size", () => {
  const items = [1, 2, 3, 4, 5].map((id) => ({ record: record(id), hash: "h" }));
  assert.deepEqual(buildBatches(items, 2, 100000).map((batch) => batch.length), [2, 2, 1]);
  const oneRecordSize = JSON.stringify(items[0].record).length;
  assert.deepEqual(buildBatches(items, 10, oneRecordSize * 2 + 1).map((batch) => batch.length), [2, 2, 1]);
});

test("model output is kept only when the product record supports it", () => {
  const records = [record(1), record(2), record(3)];
  const audited = validateAuditOutput({
    items: [
      { product_id: 1, issues: [
        { type: "duplicate_ingredient", severity: "medium", ingredient_ids: [2, 1], evidence: "Aynı madde.", suggestion: "Birini kaldır." },
        { type: "duplicate_ingredient", severity: "low", ingredient_ids: [1], evidence: "Tek id.", suggestion: "-" },
        { type: "extra_ingredient", severity: "low", ingredient_ids: [99], evidence: "Bağlı olmayan id.", suggestion: "-" },
        { type: "nutrition_inconsistent", severity: "low", ingredient_ids: [], evidence: "Şeker > karbonhidrat.", suggestion: "Düzelt." },
        { type: "nutrition_inconsistent", severity: "high", ingredient_ids: [], evidence: "Doymuş yağ > yağ.", suggestion: "Düzelt." },
        { type: "unknown", severity: "low", ingredient_ids: [], evidence: "x", suggestion: "x" },
      ] },
      { product_id: 2, issues: [] },
      { product_id: 2, issues: [] },
      { product_id: 404, issues: [] },
    ],
  }, records, new Map([[1, 500], [2, 3]]));

  assert.deepEqual([...audited.keys()], [1], "product 2 was returned twice and 3 was omitted");
  const findings = audited.get(1);
  assert.deepEqual(findings.map((finding) => [finding.type, finding.severity]), [
    ["duplicate_ingredient", "medium"],
    ["nutrition_inconsistent", "high"],
  ]);
  assert.equal(findings[0].fingerprint, "1:duplicate_ingredient:1,2");
  assert.match(findings[1].fingerprint, /^1:nutrition_inconsistent::[0-9a-f]{12}$/);
  assert.deepEqual(findings[0].ingredientIds, [1, 2], "the model listed 2 first, but 1 is linked to more products and is kept");
  assert.equal(findings[1].evidence, "Şeker > karbonhidrat. / Doymuş yağ > yağ.");
});

test("each finding carries the product name and a plain description of the data and of approving it", () => {
  const product = {
    product_id: 4521,
    name: "Çikolatalı Gofret",
    brand: "Tadım",
    category: ["Atıştırmalık", "Gofret"],
    ingredients_text: "Buğday unu, şeker, kakao kütlesi",
    linked_ingredients: [{ id: 12, name: "Buğday Unu" }, { id: 56, name: "Kakao Kütlesi" }, { id: 55, name: "Kakao Kitlesi" }, { id: 70, name: "Süt Tozu" }],
    nutrition_per_100: { energy_kj: 450, carbohydrate_g: 70, sugar_g: 35.5, fat_g: 20, saturates_g: null, proteins_g: 7, fibres_g: null, salt_g: 0.3 },
  };
  const issue = (type, ids) => ({ type, severity: "high", ingredient_ids: ids, evidence: "Kanıt", suggestion: "Öneri" });
  const findings = validateAuditOutput({ items: [{ product_id: 4521, issues: [
    issue("duplicate_ingredient", [56, 55]),
    issue("extra_ingredient", [70]),
    issue("nutrition_inconsistent", []),
    issue("missing_ingredient", []),
  ] }] }, [product], new Map([[56, 752], [55, 12]])).get(4521);

  assert.deepEqual(findings.map((finding) => [finding.productName, finding.brandName]), Array(4).fill(["Çikolatalı Gofret", "Tadım"]));
  assert.deepEqual(findings.map((finding) => finding.onApprove), [
    'SQL ile düzelir: "Kakao Kitlesi" (#55) bağlantısı silinir, "Kakao Kütlesi" (#56) kalır.',
    'SQL ile düzelir: "Süt Tozu" (#70) bağlantısı silinir.',
    "Elle düzeltilir: onaylarsan elle düzeltme listesine eklenir, SQL üretilmez.",
    "Elle düzeltilir: onaylarsan elle düzeltme listesine eklenir, SQL üretilmez.",
  ]);
  const koruyucu = { ...product, linked_ingredients: [...product.linked_ingredients, { id: 1041, name: "Koruyucu" }] };
  const [classFinding] = validateAuditOutput({ items: [{ product_id: 4521, issues: [issue("missing_ingredient", [1041])] }] }, [koruyucu]).get(4521);
  assert.equal(classFinding.onApprove,
    'Elle düzeltilir: "Koruyucu" (#1041) bağlantısı kaldırılıp metindeki maddeler ayrı ayrı bağlanmalı; SQL üretilmez.');
  assert.equal(findings[0].productData,
    "İçindekiler: Buğday unu, şeker, kakao kütlesi | Bağlı bileşenler: Buğday Unu (#12), Kakao Kütlesi (#56), Kakao Kitlesi (#55), Süt Tozu (#70)");
  assert.equal(findings[2].productData,
    "100 g/ml: Enerji 450 kJ · Karbonhidrat 70 g (şeker 35,5 g) · Yağ 20 g (doymuş —) · Protein 7 g · Lif — · Tuz 0,3 g");
});

test("a finding without ingredient ids gets a new fingerprint only when the data it is about changes", () => {
  const nutritionIssue = { type: "nutrition_inconsistent", severity: "high", ingredient_ids: [], evidence: "Şeker > karbonhidrat.", suggestion: "-" };
  const fingerprintFor = (product) => validateAuditOutput({ items: [{ product_id: 1, issues: [nutritionIssue] }] }, [product]).get(1)[0].fingerprint;
  const original = { ...record(1), nutrition_per_100: { carbohydrate_g: 4.5, sugar_g: 12 } };

  assert.equal(fingerprintFor({ ...original, name: "Yeni ad", ingredients_text: "Süt" }), fingerprintFor(original),
    "an unrelated change keeps the row, so a rejected finding stays rejected");
  assert.notEqual(fingerprintFor({ ...original, nutrition_per_100: { carbohydrate_g: 14, sugar_g: 12 } }), fingerprintFor(original),
    "changed nutrition opens a new row");
});

test("the Gemini client alternates keys, spaces each key and sends the key in a header", async () => {
  let clock = 0;
  const waits = [];
  const keys = [];
  const client = createGeminiClient({
    apiKeys: ["key-a", "key-b"],
    model: "gemma-4-31b-it",
    keyIntervalMs: 60000,
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    fetch: async (url, options) => {
      assert.doesNotMatch(url, /key=/);
      keys.push(options.headers["x-goog-api-key"]);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "düşünce", thought: true }, { text: '{"items":[]}' }] } }] }) };
    },
  });
  for (let index = 0; index < 3; index += 1) assert.deepEqual((await client.generateJson("p", {})).output, { items: [] });
  assert.deepEqual(keys, ["key-a", "key-b", "key-a"]);
  assert.deepEqual(waits, [60000], "key-a waits a full interval before its second request");
});

test("the Gemini client retries overload errors and fails fast on bad requests", async () => {
  const waits = [];
  let calls = 0;
  const responses = [
    { ok: false, status: 503, text: async () => '{"error":{"message":"high demand"}}' },
    { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"items":[]}' }] } }] }) },
  ];
  const retrying = createGeminiClient({
    apiKeys: ["k"], model: "m", keyIntervalMs: 1, sleep: async (ms) => { waits.push(ms); }, fetch: async () => responses[calls++],
  });
  assert.deepEqual((await retrying.generateJson("p", {})).output, { items: [] });
  assert.equal(calls, 2);
  assert.ok(waits.includes(15000), "first retry waits 15 seconds");

  let badCalls = 0;
  const failing = createGeminiClient({
    apiKeys: ["k"], model: "m", keyIntervalMs: 1, sleep: async () => {},
    fetch: async () => { badCalls += 1; return { ok: false, status: 400, text: async () => "bad" }; },
  });
  await assert.rejects(failing.generateJson("p", {}), /HTTP 400/);
  assert.equal(badCalls, 1);
});

test("the Gemini client does not retry past the deadline", async () => {
  let clock = 0;
  let calls = 0;
  const client = createGeminiClient({
    apiKeys: ["k"], model: "m", keyIntervalMs: 1, now: () => clock, sleep: async (ms) => { clock += ms; },
    fetch: async () => { calls += 1; return { ok: false, status: 500, text: async () => "Internal error" }; },
  });
  await assert.rejects(client.generateJson("p", {}, { deadline: 20000 }), /HTTP 500.*time budget reached/);
  assert.equal(calls, 2, "the 15 s retry fits before the deadline, the 30 s one does not");
});

test("audit saves validated products, leaves skipped ones for tomorrow and stops after repeated failures", async () => {
  const queries = [];
  const client = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
  const batches = [
    [{ record: record(1), hash: "h1" }, { record: record(2), hash: "h2" }],
    [{ record: record(3), hash: "h3" }],
    [{ record: record(4), hash: "h4" }],
    [{ record: record(5), hash: "h5" }],
    [{ record: record(6), hash: "h6" }],
  ];
  let call = 0;
  const gemini = {
    model: "gemma-4-31b-it",
    generateJson: async () => {
      call += 1;
      if (call === 1) return { output: { items: [{ product_id: 1, issues: [] }] }, usage: {} };
      throw new Error("Gemini HTTP 500: Internal error encountered.");
    },
  };
  const summary = await auditBatches({ client, gemini, batches, template: "{{products}}", maxMinutes: 60, log: () => {} });

  assert.equal(summary.audited, 1);
  assert.equal(summary.skipped, 1 + 3, "product 2 was omitted and three batches failed");
  assert.equal(summary.stoppedEarly, "3 consecutive failed batches");
  assert.equal(call, 4, "the fifth batch is not attempted");
  const stateWrites = queries.filter((query) => query.sql.includes("product_audit_state"));
  assert.deepEqual(stateWrites.map((query) => query.params[0]), [1]);
  assert.ok(queries.some((query) => query.sql === "COMMIT"));
});

test("with two keys two requests run at the same time; one key carries one request at a time", async () => {
  const deferredResponse = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const okBody = { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"items":[]}' }] } }] }) };

  for (const [keys, expectedInFlight] of [[["a", "b"], 2], [["a"], 1]]) {
    let inFlight = 0;
    let maxInFlight = 0;
    const pending = [];
    const client = createGeminiClient({
      apiKeys: keys, model: "m", keyIntervalMs: 0, sleep: async () => {},
      fetch: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const response = deferredResponse();
        pending.push(response);
        await response.promise;
        inFlight -= 1;
        return okBody;
      },
    });
    const calls = [client.generateJson("p", {}), client.generateJson("p", {})];
    while (pending.length < expectedInFlight) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, expectedInFlight);
    while (pending.length) {
      pending.shift().resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(calls);
    assert.equal(maxInFlight, expectedInFlight, `${keys.length} key(s)`);
  }
});

test("a key carries up to keyConcurrency requests and spaces their starts", async () => {
  let clock = 0;
  const waits = [];
  const pending = [];
  const client = createGeminiClient({
    apiKeys: ["a"], model: "m", keyIntervalMs: 30000, keyConcurrency: 2,
    now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; },
    fetch: async () => {
      await new Promise((resolve) => pending.push(resolve));
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"items":[]}' }] } }] }) };
    },
  });
  assert.equal(client.slots, 2);
  const settle = async () => { for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const calls = [client.generateJson("p", {}), client.generateJson("p", {}), client.generateJson("p", {})];
  await settle();
  assert.equal(pending.length, 2, "the third request waits for a free slot");
  assert.deepEqual(waits, [30000], "the second request starts 30 s after the first");
  pending.shift()();
  await settle();
  assert.equal(pending.length, 2);
  assert.deepEqual(waits, [30000, 30000], "the third request starts 30 s after the second");
  while (pending.length) pending.shift()();
  await Promise.all(calls);
});

test("parallel batches never interleave database saves", async () => {
  let saving = false;
  let overlaps = 0;
  const saved = [];
  const batches = [1, 2, 3, 4].map((id) => [{ record: record(id), hash: `h${id}` }]);
  const gemini = {
    model: "m",
    generateJson: async (prompt) => {
      const [product] = JSON.parse(prompt);
      await new Promise((resolve) => setTimeout(resolve, 5 * (5 - product.product_id)));
      return { output: { items: [{ product_id: product.product_id, issues: [] }] }, usage: {} };
    },
  };
  const summary = await auditBatches({
    client: null, gemini, batches, template: "{{products}}", maxMinutes: 60, concurrency: 2, log: () => {},
    save: async (result) => {
      if (saving) overlaps += 1;
      saving = true;
      await new Promise((resolve) => setTimeout(resolve, 3));
      saved.push(result.productId);
      saving = false;
    },
  });
  assert.equal(summary.audited, 4);
  assert.equal(overlaps, 0);
  assert.deepEqual([...saved].sort(), [1, 2, 3, 4]);
});
