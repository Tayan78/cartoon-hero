// Databasens SQL (worker/src/data.js) mot riktig SQLite – samma motor som D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dbStatus, handleData, linkProducts, listingTexts, needsDetail, queryListings, unresolvedListings, upsertCategories, upsertListings, upsertSellers } from "../worker/src/data.js";

// Minimal D1: prepare().bind().all()/run() och batch() i en transaktion.
function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of ["0001_market.sql", "0002_raw.sql", "0003_series.sql", "0004_monitoring.sql", "0005_products.sql", "0006_detail.sql"]) sqlite.exec(readFileSync(new URL(`../worker/migrations/${f}`, import.meta.url), "utf8"));
  const prepare = (sql) => {
    let params = [];
    const s = {
      bind: (...p) => ((params = p), s),
      all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
      run: async () => (sqlite.prepare(sql).run(...params), { success: true }),
    };
    return s;
  };
  const batch = async (list) => {
    sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const st of list) out.push(await st.all());
      sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }
  };
  return { prepare, batch, sqlite };
}

const listing = (o) => ({ id: "1", seller: "Daisy", seller_id: "9", title: "Schleich Tinker sto 13279", status: "Aktiv", price: 89, niche: "djur", ...o });

test("Annonser: ny rad, prisändring blir prishistorik, saknade fält skriver inte över", async () => {
  const db = fakeD1();
  await upsertListings(db, [listing({ first_price: 99, first_seen: "2026-10-01T03:00:00Z", price: 99, last_seen: "2026-10-01T03:00:00Z", model_number: "13279", text: "Fin" })]);
  // Natten efter: lägre pris, inget modellnummer eller text i raden (oförändrat).
  await upsertListings(db, [listing({ price: 89, last_seen: "2026-10-02T03:00:00Z", price_changes: 1 })]);
  // Samma pris igen: ingen ny historikpunkt.
  await upsertListings(db, [listing({ price: 89, last_seen: "2026-10-03T03:00:00Z", status: "Såld", sold_seen: "2026-10-03T03:00:00Z" })]);

  const [row] = db.sqlite.prepare("SELECT * FROM listings").all();
  assert.deepEqual(
    [row.price, row.first_price, row.model_number, row.text, row.status, row.price_changes, row.last_seen, row.sold_seen],
    [89, 99, "13279", "Fin", "Såld", 1, "2026-10-03T03:00:00Z", "2026-10-03T03:00:00Z"],
  );
  const history = db.sqlite.prepare("SELECT seen_at, price FROM price_history ORDER BY seen_at").all().map((h) => [h.seen_at, h.price]);
  assert.deepEqual(history, [["2026-10-01T03:00:00Z", 99], ["2026-10-02T03:00:00Z", 89]]);
});

test("Kopiering från arket: första priset och nuvarande pris blir två historikpunkter; går att köra om", async () => {
  const db = fakeD1();
  const row = listing({ id: "2", first_price: 120, first_seen: "2026-09-01T03:00:00Z", price: 95, last_seen: "2026-10-30T03:00:00Z" });
  await upsertListings(db, [row]);
  await upsertListings(db, [row]); // samma data igen = inga dubbletter
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM listings").get().n, 1);
  assert.deepEqual(db.sqlite.prepare("SELECT price FROM price_history ORDER BY seen_at").all().map((h) => h.price), [120, 95]);
});

test("Säljare: upsert behåller fält som inte skickas; tomt fel rensar felet", async () => {
  const db = fakeD1();
  await upsertSellers(db, [{ id: "9", alias: "Daisy", watched: 1, niches: "djur", error: "Tradera 500" }]);
  await upsertSellers(db, [{ id: "9", collected_at: "2026-10-31T03:00:00Z", in_db: 120, error: "" }]);
  const s = db.sqlite.prepare("SELECT * FROM sellers").get();
  assert.deepEqual([s.alias, s.watched, s.niches, s.in_db, s.error], ["Daisy", 1, "djur", 120, ""]);
});

test("Status och adresser: antal per nisch, fel metod, för många rader", async () => {
  const db = fakeD1();
  await upsertListings(db, [listing({ id: "1" }), listing({ id: "2", status: "Såld" }), listing({ id: "3", niche: "smurfar", status: "Såld" })]);
  await upsertSellers(db, [{ id: "9", watched: 1 }, { id: "8", watched: 0 }]);
  const st = await dbStatus(db);
  assert.deepEqual([st.listings, st.sold, st.active, st.sellers, st.watched], [3, 2, 1, 2, 1]);
  assert.deepEqual(st.niches.map((n) => [n.niche, n.listings, n.sold]), [["djur", 2, 1], ["smurfar", 1, 1]]);

  const env = { DB: db };
  const post = (path, body) => handleData(new Request(`https://w${path}`, { method: "POST", body: JSON.stringify(body) }), env, path);
  assert.equal((await post("/data/listings", { rows: [listing({ id: "4" })] })).status, 200);
  assert.equal((await post("/data/listings", { rows: Array.from({ length: 501 }, (_, i) => listing({ id: String(i) })) })).status, 400);
  assert.equal((await post("/data/okand", { rows: [] })).status, 404);
  assert.equal((await handleData(new Request("https://w/data/listings"), env, "/data/listings")).status, 405);
  assert.equal((await handleData(new Request("https://w/data/status"), {}, "/data/status")).status, 500); // ingen databas kopplad
});

test("Läsning: annonser med valda statusar, med text (för nischkontrollen)", async () => {
  const db = fakeD1();
  await upsertListings(db, [listing({ id: "1", status: "Såld", text: "Schleich 13279" }), listing({ id: "2", status: "Osåld" }), listing({ id: "3", status: "Aktiv" })]);
  const { rows } = await queryListings(db, { statuses: ["Såld", "Osåld"] });
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.price, r.text]).sort(), [["1", "Såld", 89, "Schleich 13279"], ["2", "Osåld", 89, null]]);
  assert.deepEqual((await queryListings(db, {})).rows, []);
  const res = await handleData(new Request("https://w/data/query", { method: "POST", body: JSON.stringify({ statuses: ["Aktiv"] }) }), { DB: db }, "/data/query");
  assert.deepEqual((await res.json()).rows.map((r) => r.id), ["3"]);
});

test("Allt från säljarna: databasen räknar första/lägsta pris och prisändringar själv; oförändrad annons skrivs inte", async () => {
  const db = fakeD1();
  const base = { id: "7", title: "Lego 6000 bitar", type: "köp nu", status: "Aktiv", category_id: 1612, source: "säljare", raw: '{"id":7}' };
  // Utan arkets första/lägsta pris (annonsen finns bara i databasen).
  await upsertListings(db, [{ ...base, price: 300, last_seen: "d1", first_seen: "d1" }]);
  await upsertListings(db, [{ ...base, price: 250, last_seen: "d2", first_seen: "d2" }]);
  await upsertListings(db, [{ ...base, price: 280, last_seen: "d3", first_seen: "d3" }]);
  await upsertListings(db, [{ ...base, price: 280, last_seen: "d4", first_seen: "d4", raw: '{"id":7,"ny":1}' }]); // oförändrad
  const r = db.sqlite.prepare("SELECT * FROM listings WHERE id = '7'").get();
  assert.deepEqual(
    [r.first_price, r.first_seen, r.lowest_price, r.price, r.price_changes, r.last_seen, r.raw, r.category_id, r.source],
    [300, "d1", 250, 280, 2, "d3", '{"id":7}', 1612, "säljare"],
  );

  // Auktion: stigande bud är inga prisändringar och sänker inte lägsta priset.
  const auction = { id: "8", title: "Schleich häst", type: "auktion", status: "Aktiv" };
  await upsertListings(db, [{ ...auction, price: 50, first_seen: "d1", last_seen: "d1" }]);
  await upsertListings(db, [{ ...auction, price: 80, bids: 3, last_seen: "d2" }]);
  const a = db.sqlite.prepare("SELECT * FROM listings WHERE id = '8'").get();
  assert.deepEqual([a.price, a.first_price, a.lowest_price, a.price_changes], [80, 50, 50, null]);
});

test("Okänt utfall: avslutade Köp nu utan status (eller fortfarande Aktiv), inte auktioner; seriesparas", async () => {
  const db = fakeD1();
  await upsertListings(db, [
    { id: "1", title: "a", type: "köp nu", status: null, end_at: "2026-10-01", series: "bayala" },
    { id: "2", title: "b", type: "köp nu", status: "Aktiv", end_at: "2026-10-02" },
    { id: "3", title: "c", type: "köp nu", status: "Såld", end_at: "2026-10-03" },
    { id: "4", title: "d", type: "auktion", status: null, end_at: "2026-10-04" },
    { id: "5", title: "e", type: "köp nu", status: "Aktiv", end_at: "2026-12-01" }, // inte slut än
  ]);
  assert.deepEqual((await unresolvedListings(db, { now: "2026-10-31" })).ids, ["1", "2"]);
  assert.equal(db.sqlite.prepare("SELECT series FROM listings WHERE id = '1'").get().series, "bayala");
  // Sökningen skickar ingen status för avslutad Köp nu: en redan känd status står kvar.
  await upsertListings(db, [{ id: "3", title: "c", type: "köp nu", status: null, price: 99, end_at: "2026-10-03" }]);
  assert.equal(db.sqlite.prepare("SELECT status FROM listings WHERE id = '3'").get().status, "Såld");
});

test("Översikten: anrop summeras per dygn, körningar (3 senaste per typ), tillväxt och sålda per månad", async () => {
  const { addUsage, dashboard, recordRun } = await import("../worker/src/monitor.js");
  const db = fakeD1();
  const now = Date.parse("2026-10-31T12:00:00Z");
  await addUsage(db, { tradera_search: 3, gemini: 1, tom: 0 }, now);
  await addUsage(db, { tradera_search: 2 }, now);
  await addUsage(db, { tradera_search: 5 }, now - 86400000);
  for (let i = 1; i <= 4; i++) {
    const { id } = await recordRun(db, { name: "schleich", started_at: `2026-10-2${i}T03:00:00Z` });
    await recordRun(db, { id, finished_at: `2026-10-2${i}T03:01:00Z`, status: "Klar", summary: `körning ${i}` });
  }
  await recordRun(db, { name: "marknad", started_at: "2026-10-31T03:00:00Z" });
  await upsertListings(db, [
    { id: "1", title: "a", status: "Såld", end_at: "2026-09-10T10:00:00+02:00", first_seen: "2026-10-30T03:00:00Z" },
    { id: "2", title: "b", status: "Såld", end_at: "2026-10-01T10:00:00+02:00", first_seen: "2026-10-31T03:00:00Z" },
    { id: "3", title: "c", type: "köp nu", status: null, end_at: "2026-10-02T10:00:00+02:00", first_seen: "2026-10-31T03:00:00Z", series: "bayala" },
  ]);
  const d = await dashboard(db, { now });
  assert.deepEqual(d.usage.map((u) => [u.day, u.api, u.count]).sort(), [["2026-10-30", "tradera_search", 5], ["2026-10-31", "gemini", 1], ["2026-10-31", "tradera_search", 5]]);
  assert.deepEqual(d.runs.schleich.map((r) => r.summary), ["körning 4", "körning 3", "körning 2"]);
  assert.deepEqual([d.runs.marknad[0].status, d.runs.marknad[0].finished_at], ["Pågår", null]);
  assert.deepEqual(d.growth.map((g) => [g.day, g.n]), [["2026-10-30", 1], ["2026-10-31", 2]]);
  assert.deepEqual(d.sold_by_month.map((m) => [m.month, m.n]), [["2026-09", 1], ["2026-10", 1]]);
  assert.deepEqual([d.db.listings, d.db.sold, d.db.unresolved], [3, 2, 1]);
  assert.ok(d.db.series.some((s) => s.key === "bayala"));
});

test("Förslag på konkurrenter: rankas på sålt Schleich, säljgrad, median och vad de säljer; bevakade märks", async () => {
  const { competitors } = await import("../worker/src/monitor.js");
  const db = fakeD1();
  const now = Date.parse("2026-10-31T12:00:00Z");
  const rows = [];
  // Hanna: 12 annonser, 8 sålda (Bayala), 2 osålda, 2 aktiva. Daisy (bevakas): 10, 3 sålda.
  for (let i = 0; i < 12; i++) rows.push({ id: `h${i}`, seller_id: "2", seller: "Hanna", title: "Schleich Bayala", series: "bayala", source: "sök", status: i < 8 ? "Såld" : i < 10 ? "Osåld" : "Aktiv", price: 50 + 10 * i, end_at: i < 4 ? "2026-10-20" : "2026-01-01" });
  for (let i = 0; i < 10; i++) rows.push({ id: `d${i}`, seller_id: "1", seller: "Daisy", title: "Schleich häst", niche: "djur", source: "sök", status: i < 3 ? "Såld" : "Aktiv", price: 80, end_at: "2026-10-01" });
  // Lego från en bevakad säljare (inte Schleich) räknas inte; säljare med för få annonser visas inte.
  for (let i = 0; i < 20; i++) rows.push({ id: `l${i}`, seller_id: "1", seller: "Daisy", title: "Lego", source: "säljare", status: "Såld", price: 300 });
  for (let i = 0; i < 3; i++) rows.push({ id: `x${i}`, seller_id: "3", seller: "Liten", title: "Schleich ko", niche: "djur", source: "sök", status: "Såld", price: 40 });
  await upsertListings(db, rows);
  await upsertSellers(db, [{ id: "1", alias: "Daisy", watched: 1 }]);
  const { sellers } = await competitors(db, { now, min: 10 });
  assert.deepEqual(sellers.map((s) => [s.alias, s.listings, s.sold, s.active, s.sold_90d, s.sell_through, s.watched]), [
    ["Hanna", 12, 8, 2, 4, 80, false],
    ["Daisy", 10, 3, 7, 3, 100, true],
  ]);
  assert.equal(sellers[0].median_sold, 85); // 50–120 → median av 8 = (80 + 90) / 2
  assert.deepEqual(sellers[0].mix, [{ key: "bayala", share: 100 }]);
  assert.deepEqual(sellers[1].mix, [{ key: "djur", share: 100 }]);
});

test("Produkter: annonser med products skapar produkt och koppling; säkrare tolkning ersätter osäkrare", async () => {
  const db = fakeD1();
  const p = (key, method, confidence) => ({ key, model_number: key.split("-")[1], method, confidence });
  await upsertListings(db, [
    { id: "1", title: "Schleich 13729", source: "sök", status: "Såld", price: 89, last_seen: "d1", products: [p("SCHLEICH-13729", "rubrik", 0.95)] },
    { id: "2", title: "Schleich 13729 och 13649", source: "sök", status: "Såld", price: 300, last_seen: "d1", products: [p("SCHLEICH-13729", "rubrik", 0.8), p("SCHLEICH-13649", "rubrik", 0.8)] },
    { id: "3", title: "Schleich häst", source: "sök", status: "Aktiv", price: 50, last_seen: "d1" },
  ]);
  assert.deepEqual(db.sqlite.prepare("SELECT key, brand, model_number FROM products ORDER BY key").all().map((r) => [r.key, r.brand, r.model_number]), [["SCHLEICH-13649", "Schleich", "13649"], ["SCHLEICH-13729", "Schleich", "13729"]]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM listing_products").get().n, 3);
  // Osäkrare tolkning skriver inte över; säkrare gör det.
  await linkProducts(db, [{ id: "1", products: [p("SCHLEICH-13729", "ai", 0.5)] }]);
  assert.equal(db.sqlite.prepare("SELECT method FROM listing_products WHERE listing_id = '1'").get().method, "rubrik");
  await linkProducts(db, [{ id: "3", products: [{ ...p("SCHLEICH-13773", "ai", 0.7), model_version: "gemini-x" }] }]);
  assert.deepEqual({ ...db.sqlite.prepare("SELECT method, confidence, model_version FROM listing_products WHERE listing_id = '3'").get() }, { method: "ai", confidence: 0.7, model_version: "gemini-x" });
  // Utan produkt: bara annons 3 saknade – nu ingen.
  assert.deepEqual((await listingTexts(db, { unlinked: true })).rows, []);
  assert.deepEqual((await listingTexts(db, { after: "1" })).rows.map((r) => r.id), ["2", "3"]);
});

test("Observationer: ny annons och varje ändring av pris, bud eller status – inte oförändrade nätter", async () => {
  const db = fakeD1();
  const a = { id: "9", title: "Schleich häst", type: "auktion", source: "sök" };
  await upsertListings(db, [{ ...a, status: "Aktiv", price: 100, bids: 0, last_seen: "d1" }]);
  await upsertListings(db, [{ ...a, status: "Aktiv", price: 100, bids: 0, last_seen: "d2" }]); // oförändrad
  await upsertListings(db, [{ ...a, status: "Aktiv", price: 185, bids: 5, last_seen: "d3" }]);
  await upsertListings(db, [{ ...a, status: "Såld", price: 310, bids: 12, last_seen: "d4" }]);
  await upsertListings(db, [{ ...a, status: null, price: 310, bids: 12, last_seen: "d5" }]); // okänd status = oförändrad
  const snaps = db.sqlite.prepare("SELECT seen_at, price, bids, status FROM listing_snapshots ORDER BY seen_at").all().map((r) => [r.seen_at, r.price, r.bids, r.status]);
  assert.deepEqual(snaps, [["d1", 100, 0, "Aktiv"], ["d3", 185, 5, "Aktiv"], ["d4", 310, 12, "Såld"]]);
});

test("Kategorier: upsert, och oförändrade rader skrivs inte om", async () => {
  const db = fakeD1();
  await upsertCategories(db, [{ id: 1000532, name: "Miniatyrer", parent_id: 2, path: "Leksaker > Miniatyrer" }]);
  await upsertCategories(db, [{ id: 1000532, name: "Miniatyrer & leksaksfigurer", parent_id: 2, path: "Leksaker > Miniatyrer & leksaksfigurer" }]);
  assert.equal(db.sqlite.prepare("SELECT name FROM categories").get().name, "Miniatyrer & leksaksfigurer");
});

test("Produktstatistik: täckning, och pris/säljgrad bara från annonser med en enda produkt", async () => {
  const { productStats } = await import("../worker/src/monitor.js");
  const db = fakeD1();
  const p = (key) => ({ key, model_number: key.slice(-5), method: "rubrik", confidence: 0.95 });
  await upsertListings(db, [
    { id: "1", title: "Schleich Tinker 13773", source: "sök", status: "Såld", price: 80, products: [p("SCHLEICH-13773")] },
    { id: "2", title: "Schleich Tinker 13773", source: "sök", status: "Såld", price: 100, products: [p("SCHLEICH-13773")] },
    { id: "3", title: "Schleich Tinker sto 13773", source: "sök", status: "Osåld", price: 150, products: [p("SCHLEICH-13773")] },
    { id: "4", title: "Paket 13773 13729", source: "sök", status: "Såld", price: 500, products: [p("SCHLEICH-13773"), p("SCHLEICH-13729")] },
    { id: "5", title: "Schleich häst", source: "sök", status: "Aktiv", price: 40 },
  ]);
  const d = await productStats(db);
  assert.deepEqual([d.coverage.schleich, d.coverage.linked, d.coverage.share, d.coverage.products], [5, 4, 80, 2]);
  const t = d.products[0];
  assert.deepEqual([t.key, t.listings, t.sold, t.median_sold, t.sell_through, t.name], ["SCHLEICH-13773", 4, 3, 90, 67, "Schleich Tinker 13773"]);
});

test("Annonsdetalj: nyast först, bara de som saknar; detaljen skrivs även om pris och status är oförändrade", async () => {
  const db = fakeD1();
  await upsertListings(db, [
    { id: "1", title: "Schleich a", source: "sök", status: "Aktiv", price: 50, first_seen: "2026-10-31" },
    { id: "2", title: "Schleich b", source: "sök", status: "Aktiv", price: 50, first_seen: "2026-11-01" },
    { id: "3", title: "Lego", source: "säljare", status: "Aktiv", price: 50, first_seen: "2026-11-01" }, // inte Schleich
  ]);
  assert.deepEqual((await needsDetail(db, { limit: 5 })).ids, ["2", "1"]);
  await upsertListings(db, [{ id: "2", description: "<p>Art.nr 13729</p>", text: "Art.nr 13729", detail_at: "d", opening_price: 49, image_count: 3 }]);
  const r = db.sqlite.prepare("SELECT description, opening_price, image_count, price, status FROM listings WHERE id = '2'").get();
  assert.deepEqual([r.description, r.opening_price, r.image_count, r.price, r.status], ["<p>Art.nr 13729</p>", 49, 3, 50, "Aktiv"]);
  assert.deepEqual((await needsDetail(db)).ids, ["1"]);
  // Efterhandskopplingen läser hela beskrivningen.
  assert.equal((await listingTexts(db, { after: "1" })).rows[0].text, "<p>Art.nr 13729</p>");
});
