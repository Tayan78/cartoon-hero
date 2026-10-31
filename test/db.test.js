import { test } from "node:test";
import assert from "node:assert/strict";
import { DB_CHUNK, dbMarketRows, dbWrite, toDbListing, toDbSeller } from "../lib/db.js";
import { loadMarketRows } from "../lib/lots.js";
import { collectSeller, copyToDb, MARKET_HEADERS, SELLER_HEADERS } from "../lib/marketdata.js";
import { fakeAppsScript } from "./helpers/apps-script.js";

test("Arkets rader → databasens fält: tal, datum, Ja/Nej, tomma tal blir null", () => {
  const l = toDbListing({
    "Annons-ID": 123, Säljare: "Daisy", "Säljar-ID": 42, Rubrik: "Schleich Tinker sto", Modellnummer: "13279", Status: "Såld",
    Pris: "89", "Första pris": 99, Frakt: "", Start: new Date("2026-10-01T10:00:00Z"), "Senast sedd": "2026-10-31T03:00:00.000Z", Nisch: "djur",
  });
  assert.deepEqual(l, {
    id: "123", seller: "Daisy", seller_id: "42", title: "Schleich Tinker sto", model_number: "13279", status: "Såld",
    price: 89, first_price: 99, shipping: null, start_at: "2026-10-01T10:00:00.000Z", last_seen: "2026-10-31T03:00:00.000Z", niche: "djur",
  });
  assert.deepEqual(toDbSeller({ "Säljar-ID": "42", Bevakad: "Ja", Fel: "", Betyg: 4.9 }), { id: "42", watched: 1, error: "", rating: 4.9 });
  assert.deepEqual(toDbSeller({ "Säljar-ID": "42", Bevakad: "Nej" }), { id: "42", watched: 0 });
});

test("Skrivning: delas upp i delar, skickar token och kastar fel från databasen", async (t) => {
  t.after(() => delete process.env.APP_TOKEN);
  const calls = [];
  const fetchImpl = async (url, init) => (calls.push({ url, init }), new Response(JSON.stringify({ ok: true }), { status: 200 }));
  assert.deepEqual(await dbWrite("listings", [{ "Annons-ID": "1" }], { fetchImpl }), { written: 0 }); // utan APP_TOKEN: hoppas över
  process.env.APP_TOKEN = "hemligt";
  const rows = Array.from({ length: DB_CHUNK + 5 }, (_, i) => ({ "Annons-ID": String(i), Rubrik: "x" }));
  assert.deepEqual(await dbWrite("listings", [...rows, { Rubrik: "utan id" }], { fetchImpl }), { written: DB_CHUNK + 5 });
  assert.deepEqual(calls.map((c) => [c.url.replace(/^https:\/\/[^/]+/, ""), JSON.parse(c.init.body).rows.length]), [["/data/listings", DB_CHUNK], ["/data/listings", 5]]);
  assert.equal(calls[0].init.headers["x-app-token"], "hemligt");
  const failing = async () => new Response(JSON.stringify({ ok: false, error: "D1 nere" }), { status: 500 });
  await assert.rejects(dbWrite("sellers", [{ "Säljar-ID": "1" }], { fetchImpl: failing }), /Databasen: D1 nere/);
});

const item = (id, o = {}) => ({ id, title: "Schleich Tinker sto", number: "13279", number_source: "text", type: "köp nu", price: 89, bids: 0, shipping: 49, condition: "", start: "2026-10-01T10:00:00.000Z", end: "2026-10-31T10:00:00.000Z", days: 27, restarts: 0, url: "u", text: "Schleich 13279", sold: false, ended: false, ...o });
const fetchItems = async () => ({ alias: "Daisy93", user_id: "42", detail: {}, items: [item(1), item(2)] });

test("Insamling skriver samma rader till databasen; fel där stoppar inte arket men syns på säljaren", async () => {
  const gs = fakeAppsScript();
  const written = [];
  const db = async (table, rows) => written.push([table, rows.map((r) => r["Annons-ID"] ?? r["Säljar-ID"])]);
  const r = await collectSeller({ alias: "Daisy93", user_id: "42" }, { store: gs.store, db, fetchItems, now: Date.parse("2026-10-31T03:00:00Z") });
  assert.deepEqual(written, [["listings", ["1", "2"]], ["sellers", ["42"]]]);
  assert.equal(r.db_error, null);

  const broken = async () => {
    throw new Error("Databasen: D1 nere");
  };
  const r2 = await collectSeller({ alias: "Daisy93", user_id: "42" }, { store: gs.store, db: broken, fetchItems });
  assert.equal(r2.db_error, "Databasen: D1 nere");
  assert.equal(gs.table("Marknad").length, 2); // arket uppdaterades ändå
  assert.equal(gs.table("Säljare")[0].Fel, "Databasen: D1 nere");
});

test("Kopiering från arket: säljare första gången, annonserna i delar tills allt är kopierat", async () => {
  const gs = fakeAppsScript();
  await gs.store("sheetUpsert", { sheet: "Säljare", headers: SELLER_HEADERS, key: "Säljar-ID", rows: [{ "Säljar-ID": "42", Alias: "Daisy93" }] });
  await gs.store("sheetUpsert", { sheet: "Marknad", headers: MARKET_HEADERS, key: "Annons-ID", rows: ["1", "2", "3"].map((id) => ({ "Annons-ID": id, Rubrik: "Schleich" })) });
  const written = [];
  const db = async (table, rows) => written.push([table, rows.map((r) => String(r["Annons-ID"] ?? r["Säljar-ID"]))]);
  const first = await copyToDb({ store: gs.store, db, limit: 2 });
  assert.deepEqual([first.total, first.copied, first.done, first.next, first.sellers], [3, 2, false, 2, 1]);
  const second = await copyToDb({ store: gs.store, db, limit: 2, offset: first.next });
  assert.deepEqual([second.copied, second.done, second.sellers], [3, true, null]);
  assert.deepEqual(written, [["sellers", ["42"]], ["listings", ["1", "2"]], ["listings", ["3"]]]);
});

test("Styckpriserna läses från databasen i arkets format; svarar den inte används arket", async (t) => {
  t.after(() => delete process.env.APP_TOKEN);
  const fetchImpl = async (url, init) =>
    new Response(JSON.stringify({ ok: true, rows: [{ id: "1", seller_id: "42", title: "Schleich Tinker sto", model_number: null, status: "Såld", price: 89, niche: "djur", text: null }] }), { status: 200 });
  process.env.APP_TOKEN = "hemligt";
  assert.deepEqual(await dbMarketRows(["Såld"], { fetchImpl }), [
    { "Annons-ID": "1", "Säljar-ID": "42", Rubrik: "Schleich Tinker sto", Modellnummer: "", Status: "Såld", Pris: 89, Nisch: "djur", Text: "" },
  ]);

  const fromDb = await loadMarketRows(undefined, { db: async (statuses) => [{ Rubrik: "x", Status: statuses[0] }] });
  assert.deepEqual([fromDb.source, fromDb.rows], ["databas", [{ Rubrik: "x", Status: "Såld" }]]);
  const down = async () => {
    throw new Error("Databasen: 500");
  };
  // Databasen nere och inget ark konfigurerat (testmiljön): inga rader, men inget fel.
  assert.deepEqual(await loadMarketRows(undefined, { db: down }), { rows: null, source: null });
  // Ett eget ark (som i Fynd-testerna) läses alltid därifrån.
  const store = async (action, p) => ({ ok: true, rows: [{ Rubrik: "y", Status: p.filter.equals }] });
  assert.equal((await loadMarketRows(store, { db: down })).source, "ark");
});
