// Databasens SQL (worker/src/data.js) mot riktig SQLite – samma motor som D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dbStatus, handleData, upsertListings, upsertSellers } from "../worker/src/data.js";

// Minimal D1: prepare().bind().all()/run() och batch() i en transaktion.
function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../worker/migrations/0001_market.sql", import.meta.url), "utf8"));
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
