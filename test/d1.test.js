// Databasens SQL (worker/src/data.js) mot riktig SQLite – samma motor som D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./helpers/fake-d1.js";
import { dbStatus, handleData, linkProducts, listingTexts, needsDetail, queryListings, unresolvedListings, upsertCategories, upsertListings, upsertSellers } from "../worker/src/data.js";


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

test("Marknadsanalys: period på slutdatum, säljgrad, median, segment, veckodag/timme och kommande avslut – i SQL", async () => {
  const { marketStats } = await import("../worker/src/analytics.js");
  const db = fakeD1();
  const day = (n, h = 20) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10) + `T${String(h).padStart(2, "0")}:00:00+01:00`;
  const r = (id, title, status, price, o = {}) => ({ id, title, status, price, type: "auktion", niche: "djur", source: "sök", end_at: day(2), seller_id: "s" + id, ...o });
  await upsertListings(db, [
    r("1", "Schleich häst Tinker", "Såld", 80),
    r("2", "Schleich häst Tinker", "Osåld", 90),
    r("3", "Schleich lejon", "Såld", 50, { type: "köp nu", end_at: day(3, 10) }),
    r("4", "Schleich 10 st djur", "Såld", 200, { end_at: day(40) }),
    r("5", "Schleich Bayala älva", "Såld", 60, { niche: null, series: "bayala" }),
    r("6", "Schleich häst", "Aktiv", 99, { end_at: day(-5) }),
    r("7", "Schleich butik", "Såld", 99, { end_at: "2041-01-01T10:00:00+01:00" }), // slutdatum i framtiden räknas inte
  ]);
  const m = await marketStats(db, { days: 30 });
  assert.deepEqual([m.bucket, m.kpi.ended, m.kpi.sold, m.kpi.sell_through, m.kpi.median], ["day", 4, 3, 75, 60]);
  assert.deepEqual(Object.fromEntries(m.segments.map((s) => [s.segment, [s.sold, s.ended, s.median, s.active]])), {
    Hästar: [1, 2, 80, 1], "Övriga djur": [1, 1, 50, 0], Bayala: [1, 1, 60, 0],
  });
  assert.deepEqual(m.hour.map((h) => [h.hour, h.ended]), [[20, 3]]);
  assert.equal(m.upcoming.reduce((a, u) => a + u.n, 0), 1);
  const all = await marketStats(db, { days: "all" });
  assert.deepEqual([all.bucket, all.kpi.ended, all.kpi.median], ["week", 5, 70]);
  assert.ok(all.segments.some((s) => s.segment === "Partier" && s.sold === 1));
});

test("Inköp: spara, lista med antal fotade, koppla annonser, eget konto räknas inte som konkurrent", async () => {
  const { purchases } = await import("../worker/src/purchases.js");
  const { competitors } = await import("../worker/src/monitor.js");
  const db = fakeD1();
  const { id } = await purchases(db, { op: "save", purchase: { title: "42 st Schleich-djur", bought_at: "2026-11-02", source: "tradera", price: "380", shipping: 79, fees: 21, total_cost: 480, item_count: 42 } }, "2026-11-02T20:00:00Z");
  const { id: legacy } = await purchases(db, { op: "save", purchase: { title: "Gammalt lager", legacy: 1, total_cost: 0, bought_at: "2026-11-01" } }, "2026-11-02T20:01:00Z");
  await purchases(db, { op: "item", item: { id: "G1", purchase_id: id } });
  await purchases(db, { op: "item", item: { id: "G2", purchase_id: id } });
  await purchases(db, { op: "item", item: { id: "G2", purchase_id: legacy } }); // flyttad till annat inköp
  await purchases(db, { op: "save", purchase: { id: legacy, status: "klar" } });
  const list = await purchases(db, { op: "list" });
  assert.deepEqual(list.purchases.map((p) => [p.title, p.price, p.total_cost, p.items_registered, p.status, p.legacy]), [
    ["42 st Schleich-djur", 380, 480, 1, "öppen", 0],
    ["Gammalt lager", null, 0, 1, "klar", 1],
  ]);
  // Ditt eget konto: märks, och syns inte bland konkurrentförslagen.
  await upsertSellers(db, [{ id: "9", alias: "Joulupukkin" }, { id: "8", alias: "Daisy" }]);
  const rows = [];
  for (const [seller, alias] of [["9", "Joulupukkin"], ["8", "Daisy"]]) for (let i = 0; i < 10; i++) rows.push({ id: `${seller}-${i}`, seller_id: seller, seller: alias, title: "Schleich häst", niche: "djur", source: "sök", status: "Såld", price: 80 });
  await upsertListings(db, rows);
  await purchases(db, { op: "own_seller", seller_id: "9" });
  assert.deepEqual({ ...(await purchases(db, { op: "list" })).own_seller }, { id: "9", alias: "Joulupukkin" });
  assert.deepEqual((await competitors(db, { min: 5 })).sellers.map((s) => s.alias), ["Daisy"]);
});

test("Veckan: dina sålda mot marknaden, topp 5 utan dig själv, veckan före", async () => {
  const { weekStats } = await import("../worker/src/monitor.js");
  const db = fakeD1();
  const now = Date.parse("2026-11-10T12:00:00Z");
  const day = (d) => new Date(now - d * 86400000).toISOString();
  await upsertSellers(db, [{ id: "9", alias: "Joulupukkin" }, { id: "1", alias: "A" }, { id: "2", alias: "B" }]);
  await db.prepare("UPDATE sellers SET own = 1 WHERE id = '9'").run();
  const rows = [];
  const add = (seller, alias, n, ago, extra = {}) => { for (let i = 0; i < n; i++) rows.push({ id: `${seller}-${ago}-${i}`, seller_id: seller, seller: alias, title: "Schleich häst", niche: "djur", source: "sök", status: "Såld", price: 100, end_at: day(ago), ...extra }); };
  add("9", "Joulupukkin", 2, 1);
  add("1", "A", 5, 2);
  add("2", "B", 3, 3);
  add("1", "A", 4, 10); // veckan före
  add("2", "B", 9, 1, { niche: null, source: "säljare" }); // inte Schleich
  add("2", "B", 1, 2, { status: "Osåld", id: "x" });
  await upsertListings(db, rows);
  const w = await weekStats(db, { now });
  assert.deepEqual(w.market, { sold: 10, revenue: 1000, prev: 4 });
  assert.deepEqual({ ...w.mine }, { sold: 2, revenue: 200, prev: 0, share: 20 });
  assert.deepEqual(w.top.map((t) => [t.alias, t.sold, t.share]), [["A", 5, 50], ["B", 3, 30]]);
  assert.equal(w.own.alias, "Joulupukkin");
});

test("Modell i databasen: bara enstaka figurer, reservpris ej nått = osåld, till salu nu, median och tid till såld", async () => {
  const { modelStats } = await import("../worker/src/model.js");
  const db = fakeD1();
  const now = Date.parse("2026-11-10T12:00:00Z");
  const day = (d) => new Date(now - d * 86400000).toISOString();
  const r = (id, extra) => ({ id, seller_id: "1", seller: "A", title: "Schleich Tinker sto 13773", model_number: "13773", niche: "djur", source: "sök", ...extra });
  await upsertListings(db, [
    r("a", { status: "Såld", price: 80, start_at: day(10), end_at: day(6) }),
    r("b", { status: "Såld", price: 100, start_at: day(20), end_at: day(10) }),
    r("c", { status: "Såld", price: 120, start_at: day(5), end_at: day(3) }),
    r("d", { status: "Osåld", price: 150, end_at: day(4) }),
    r("e", { status: "Aktiv", price: 89, end_at: day(-5) }),
    r("f", { status: "Såld", price: 300, end_at: day(2), title: "10 st Schleich hästar bl.a. 13773" }), // parti
    r("g", { status: "Såld", price: 90, end_at: day(200) }), // för gammal
    r("h", { status: "Såld", price: 60, end_at: day(1), model_number: "14000" }), // annan modell
  ]);
  await db.prepare("UPDATE listings SET reserve_met = 0 WHERE id = 'c'").run();
  const m = await modelStats(db, { number: "13773", now });
  assert.deepEqual([m.sold, m.unsold, m.median, m.sell_through, m.active, m.active_low, m.asks_below_median], [2, 2, 90, 50, 1, 89, 1]);
  assert.equal(m.days_to_sell, 7);
  assert.deepEqual(m.recent.map((x) => x.price), [80, 100]);
  await assert.rejects(() => modelStats(db, { number: "x" }), /Modellnummer/);
});

test("Ditt konto i databasen: nyckeln sparas, status visar aldrig nyckeln, försäljningar uppdateras", async () => {
  const { own } = await import("../worker/src/own.js");
  const { dashboard } = await import("../worker/src/monitor.js");
  const db = fakeD1();
  assert.equal((await own(db, { op: "status" })).connected, false);
  await own(db, { op: "auth_set", auth: { user_id: "9", alias: "Joulupukkin", token: "HEMLIG", expires: "2027-11-01T00:00:00Z" } }, "2026-11-01T01:00:00Z");
  assert.equal((await own(db, { op: "auth_get" })).auth.token, "HEMLIG");
  const row = { order_id: 501, item_id: "7001", title: "Tinker", quantity: 1, unit_price: 80, created_at: "2026-11-02T10:00:00Z", updated_at: "a" };
  await own(db, { op: "sales_upsert", rows: [row, { ...row, item_id: "7002", unit_price: 60 }], synced_at: "2026-11-02T03:00:00Z" });
  await own(db, { op: "sales_upsert", rows: [{ ...row, unit_price: 75, updated_at: "b", paid_at: "2026-11-02T11:00:00Z" }] });
  const s = await own(db, { op: "status" });
  assert.deepEqual([s.connected, s.alias, s.expires, s.sales.n, s.sales.revenue, s.sync.synced_at], [true, "Joulupukkin", "2027-11-01T00:00:00Z", 2, 135, "2026-11-02T03:00:00Z"]);
  assert.ok(!JSON.stringify(s).includes("HEMLIG"));
  const d = await dashboard(db);
  assert.deepEqual({ ...d.own_auth }, { connected: true, expires: "2027-11-01T00:00:00Z", synced_at: "2026-11-02T03:00:00Z", sales: 2 });
  assert.ok(!JSON.stringify(d).includes("HEMLIG"));
  await assert.rejects(() => own(db, { op: "auth_set", auth: {} }), /token/);
});

test("Skrivbudget: annonser stoppas när dygnets budget är nådd, små skrivningar går igenom; skrivningar räknas per del", async () => {
  const db = fakeD1();
  const env = { DB: db, APP_TOKEN: "t", DAILY_WRITE_BUDGET: "50" };
  const post = (path, body) => handleData(new Request(`https://w${path}`, { method: "POST", headers: { "x-app-token": "t" }, body: JSON.stringify(body) }), env, path);
  const row = { id: "1", title: "Schleich häst 13773", status: "Aktiv", price: 80, niche: "djur", last_seen: "2026-11-01T03:00:00Z" };
  // fakeD1 ger inga rows_written, så räknaren sätts för hand.
  const { addUsage } = await import("../worker/src/monitor.js");
  assert.equal((await post("/data/listings", { rows: [row] })).status, 200);
  await addUsage(db, { d1_rows: 60 });
  const stopped = await post("/data/listings", { rows: [{ ...row, price: 70 }] });
  assert.equal(stopped.status, 429);
  assert.match((await stopped.json()).error, /skrivbudget/);
  assert.equal((await post("/data/sellers", { rows: [{ id: "9", alias: "A" }] })).status, 200);
  const { results } = await db.prepare("SELECT price FROM listings WHERE id = '1'").all();
  assert.equal(results[0].price, 80, "stoppad skrivning ändrade inget");
  const parts = await upsertListings(db, [{ ...row, id: "2" }]);
  assert.deepEqual(Object.keys(parts.parts), ["d1_rows_prices", "d1_rows_snapshots", "d1_rows_listings", "d1_rows_links"]);
});

test("Oförändrad annons skrivs inte om även om länk och alias skiljer sig (säljarens och sökningens svar)", async () => {
  const db = fakeD1();
  const base = { id: "5", title: "Schleich häst", status: "Aktiv", price: 80, type: "auktion", niche: "djur", last_seen: "2026-11-01T03:00:00Z" };
  await upsertListings(db, [{ ...base, url: "https://www.tradera.com/item/1/5/schleich-hast", seller: "Daisy" }]);
  await upsertListings(db, [{ ...base, url: "https://www.tradera.com/item/5", seller: "daisy", last_seen: "2026-11-02T03:00:00Z" }]);
  const { results } = await db.prepare("SELECT last_seen FROM listings WHERE id = '5'").all();
  assert.equal(results[0].last_seen, "2026-11-01T03:00:00Z", "ingen omskrivning");
});

test("Avbruten körning: en körning som stått som Pågår markeras Avbruten när nästa startar", async () => {
  const { recordRun } = await import("../worker/src/monitor.js");
  const db = fakeD1();
  await recordRun(db, { name: "marknad", started_at: "2026-11-01T02:37:00Z" });
  await recordRun(db, { name: "marknad", started_at: "2026-11-02T02:37:00Z" });
  const { results } = await db.prepare("SELECT status FROM runs ORDER BY started_at").all();
  assert.deepEqual(results.map((r) => r.status), ["Avbruten", "Pågår"]);
});
