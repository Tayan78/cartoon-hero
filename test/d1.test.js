// Databasens SQL (worker/src/data.js) mot riktig SQLite – samma motor som D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dbStatus, handleData, queryListings, upsertListings, upsertSellers } from "../worker/src/data.js";

// Minimal D1: prepare().bind().all()/run() och batch() i en transaktion.
function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of ["0001_market.sql", "0002_raw.sql"]) sqlite.exec(readFileSync(new URL(`../worker/migrations/${f}`, import.meta.url), "utf8"));
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
