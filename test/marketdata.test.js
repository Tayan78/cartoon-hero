import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKET_HEADERS, SELLER_HEADERS, collectSeller, discoverSellers, listSellers, marketRow, mergeMarketRow, runStatus, runStep, startRun, watchSeller } from "../lib/marketdata.js";
import { fakeAppsScript } from "./helpers/apps-script.js";
import { dataApi, fakeD1 } from "./helpers/fake-d1.js";

const hit = (id, sellerId, o = {}) => ({ id, sellerId, sellerAlias: `s${sellerId}`, shortDescription: "Schleich häst 13279", hasBids: false, sellerDsrAverage: 4.9, ...o });

test("Hitta konkurrenter: grupperar aktiva och avslutade per säljare, minst N annonser", async () => {
  const bodies = [];
  const search = async (body) => {
    bodies.push(body);
    const ended = body.itemStatus === "Ended";
    if (body.pageNumber === 1) {
      return {
        totalNumberOfPages: ended ? 1 : 2,
        items: ended ? [hit(10, 1, { hasBids: true }), hit(11, 2), hit(1, 1)] : [hit(1, 1), hit(2, 1, { shortDescription: "Schleich häst" }), hit(3, 2)],
      };
    }
    return { items: [hit(4, 1), hit(5, 3)] };
  };
  const r = await discoverSellers({ search, minListings: 2 });
  assert.equal(bodies.length, 3);
  assert.equal(r.scanned, 7); // id 1 finns i båda listorna
  assert.deepEqual(r.sellers.map((s) => s.alias), ["s1", "s2"]);
  const s1 = r.sellers[0];
  assert.deepEqual([s1.total, s1.active, s1.ended, s1.with_bids, s1.number_share, s1.rating], [4, 3, 1, 1, 75, 4.9]);
});

test("Marknadsrad: status såld/osåld/aktiv", () => {
  const seller = { alias: "Daisy93", user_id: 42 };
  const base = { id: 7, title: "Schleich Tinker", number: "13279", number_source: "text", type: "köp nu", price: 70, bids: 0, shipping: 49, condition: "", start: "", end: "", days: 3, restarts: 0, url: "u", text: "t" };
  assert.equal(marketRow({ ...base, sold: true, ended: true }, seller).status, "Såld");
  assert.equal(marketRow({ ...base, sold: false, ended: true }, seller).status, "Osåld");
  const active = marketRow({ ...base, sold: false, ended: false }, seller);
  assert.deepEqual([active.status, active.id, active.seller_id, active.seller], ["Aktiv", "7", "42", "Daisy93"]);
});

test("Insamling till databasen: bara listan, Schleich/Smurf sparas (ditt konto allt), sålt, prisändring och säljarens siffror", async () => {
  const db = fakeD1();
  const api = await dataApi(db);
  const gs = fakeAppsScript();
  await watchSeller({ id: "42", alias: "Daisy93", total: 196 }, true, { ...api, store: gs.store, url: "https://app/api/marketdata", now: Date.parse("2026-10-28T10:00:00Z") });
  assert.deepEqual(gs.triggers.map((t) => t.getHandlerFunction()), ["nightly"]);

  const item = (id, o = {}) => ({ id, title: "Schleich Tinker sto", number: "13279", number_source: "rubrik", type: "köp nu", price: 89, bids: 0, shipping: 49, condition: "", start: "2026-10-01T10:00:00.000Z", end: "2026-11-30T10:00:00.000Z", days: 27, restarts: 0, url: "u", text: "", sold: false, ended: false, ...o });
  let opts;
  const night = (items) => async (alias, o) => ((opts = o), { alias: "Daisy93", user_id: "42", detail: { fetched: 0, errors: 0 }, items });
  const r1 = await collectSeller({ alias: "Daisy93", user_id: "42" }, { put: api.put, fetchItems: night([item(1), item(2), item(3, { title: "Lego Technic 42100", number: "" })]), now: Date.parse("2026-10-28T03:00:00Z") });
  assert.ok(!opts.detailFor.test("Schleich häst"), "inga beskrivningar i säljarinsamlingen");
  assert.deepEqual([r1.items, r1.all_items, r1.db_error], [2, 3, null]);

  // Natt 2: annons 1 sänkt till 69 och såld.
  await collectSeller({ alias: "Daisy93", user_id: "42" }, { put: api.put, fetchItems: night([item(1, { price: 69, sold: true, ended: true }), item(2)]), now: Date.parse("2026-10-29T03:00:00Z") });
  const { results } = await db.prepare("SELECT id, status, price, first_price, lowest_price, price_changes, niche, source, sold_seen FROM listings ORDER BY id").all();
  assert.deepEqual(results.map((r) => r.id), ["1", "2"]);
  assert.deepEqual([results[0].status, results[0].price, results[0].first_price, results[0].lowest_price, results[0].price_changes, results[0].niche, results[0].source], ["Såld", 69, 89, 69, 1, "djur", "säljare"]);
  assert.equal(results[0].sold_seen, "2026-10-29T03:00:00.000Z");
  const links = await db.prepare("SELECT product_key FROM listing_products WHERE listing_id = '1'").all();
  assert.deepEqual(links.results.map((r) => r.product_key), ["SCHLEICH-13279"]);

  const [s] = await listSellers(api);
  assert.deepEqual([s.alias, s.watched, s.in_db, s.sold_in_db, s.collected], ["Daisy93", true, 2, 1, "2026-10-29T03:00:00.000Z"]);

  // Ditt konto: allt sparas.
  await db.prepare("INSERT INTO sellers (id, alias, own, watched) VALUES ('9', 'Joulupukkin', 1, 1)").run();
  const mine = await collectSeller({ alias: "Joulupukkin", user_id: "9", own: true }, { put: api.put, fetchItems: async () => ({ alias: "Joulupukkin", user_id: "9", items: [item(7, { title: "Lego 2 kg" })] }) });
  assert.equal(mine.items, 1);

  await watchSeller({ id: "42", alias: "Daisy93" }, false, { ...api, store: gs.store, url: "https://app/api/marketdata" });
  assert.equal(gs.triggers.length, 1, "ditt konto bevakas fortfarande");
});

test("Säljarna flyttas från arket till databasen första gången", async () => {
  const db = fakeD1();
  const api = await dataApi(db);
  const gs = fakeAppsScript();
  await gs.store("sheetUpsert", { sheet: "Säljare", headers: SELLER_HEADERS, key: "Säljar-ID", rows: [{ "Säljar-ID": "42", Alias: "Daisy93", Bevakad: "Ja", Nischer: "djur" }] });
  const imported = [];
  const importRows = async (table, rows) => (imported.push(...rows), api.put(table, rows.map((r) => ({ id: String(r["Säljar-ID"]), alias: r.Alias, watched: r.Bevakad === "Ja" ? 1 : 0, niches: r.Nischer }))));
  const list = await listSellers({ list: api.list, store: gs.store, importRows });
  assert.deepEqual(list.map((x) => [x.id, x.alias, x.watched, x.niches]), [["42", "Daisy93", true, ["djur"]]]);
  assert.equal(imported.length, 1);
  await listSellers({ list: api.list, store: gs.store, importRows });
  assert.equal(imported.length, 1, "bara första gången");
});

test("Auktioner: bud räknas inte som prisändring", () => {
  const old = { Pris: 50, "Lägsta pris": 50, Prisändringar: 0, Status: "Aktiv" };
  const row = mergeMarketRow(old, { id: "1", type: "auktion", price: 80, status: "Aktiv" }, "t");
  assert.equal(row.Prisändringar, undefined);
  assert.equal(row["Lägsta pris"], undefined);
  assert.equal(mergeMarketRow(old, { id: "1", type: "köp nu", price: 40, status: "Aktiv" }, "t").Prisändringar, 1);
});

test("Bakgrundskörning: fyra åt gången, äldst först, fel på säljaren, förlopp och status i databasen", async () => {
  const db = fakeD1();
  const api = await dataApi(db);
  const gs = fakeAppsScript();
  for (const [id, alias] of [["1", "A"], ["2", "B"], ["3", "C"], ["4", "D"], ["5", "E"]]) await watchSeller({ id, alias }, true, { ...api, store: gs.store, url: "u" });
  await api.put("sellers", [{ id: "1", collected_at: "2026-10-27T03:00:00Z" }]);
  const order = [];
  const collect = async ({ user_id }) => {
    order.push(user_id);
    if (user_id === "2") throw new Error("Tradera 500: fel");
  };
  const now = Date.now();
  let t = now;
  const clock = () => (t += 30_000); // en omgång (fyra säljare) per steg

  const run = await startRun(null, { ...api, now });
  assert.equal(run.started, true);
  assert.equal((await startRun(null, { ...api, now })).started, false); // en körning åt gången
  const first = await runStep(run.state, { ...api, collect, clock, budgetMs: 20_000 });
  assert.deepEqual([first.ran, first.more], [4, true]);
  const mid = await runStatus({ ...api, now: Date.now() });
  assert.deepEqual([mid.running, mid.done, mid.left], [true, 4, 1]);
  const second = await runStep(first.state, { ...api, collect, clock, budgetMs: 20_000 });
  assert.deepEqual([second.ran, second.more], [1, false]);
  assert.deepEqual(order.slice(4), ["1"]); // den som samlades in senast kommer sist
  const end = await runStatus({ ...api, now: Date.now() });
  assert.deepEqual([end.running, end.status], [false, "Klar, 1 fel"]);
  assert.equal((await listSellers(api)).find((s) => s.id === "2").error, "Tradera 500: fel");

  // Bara en säljare (Samla nu).
  order.length = 0;
  const one = await startRun(["3"], { ...api, now: Date.now() });
  const step = await runStep(one.state, { ...api, collect, clock });
  assert.deepEqual([order, step.more], [["3"], false]);

  // Stannad körning (inget livstecken på 3 min) räknas inte som pågående.
  await startRun(null, { ...api, now: Date.now() });
  const stale = await runStatus({ ...api, now: Date.now() + 4 * 60 * 1000 });
  assert.deepEqual([stale.running, stale.status], [false, "Avbruten"]);
});

test("Nischer: smurfar och djur märks, annat sparas inte, säljarens nischer sparas", async () => {
  const db = fakeD1();
  const api = await dataApi(db);
  const gs = fakeAppsScript();
  await watchSeller({ id: "5", alias: "SmurfSäljaren", niche: "smurfar" }, true, { ...api, store: gs.store, url: "u" });
  await watchSeller({ id: "5", alias: "SmurfSäljaren", niche: "djur" }, true, { ...api, store: gs.store, url: "u" });
  assert.deepEqual((await listSellers(api))[0].niches, ["smurfar", "djur"]);
  const it = (id, title) => ({ id, title, number: "", number_source: "", type: "köp nu", price: 30, bids: 0, shipping: 49, condition: "", start: "", end: "", days: 1, restarts: 0, url: "u", text: "", sold: false, ended: false });
  await collectSeller({ alias: "SmurfSäljaren", user_id: "5" }, { put: api.put, fetchItems: async () => ({ alias: "SmurfSäljaren", user_id: "5", items: [it(1, "Smurf med blomma Schleich 20044"), it(2, "Schleich Tinker sto 13279"), it(3, "Barbie docka")] }) });
  const { results } = await db.prepare("SELECT id, niche FROM listings ORDER BY id").all();
  assert.deepEqual(results.map((r) => [r.id, r.niche]), [["1", "smurfar"], ["2", "djur"]]);
});

test("Hitta konkurrenter per nisch: sökord och bara nischens annonser räknas", async () => {
  const words = [];
  const search = async (body) => {
    words.push(body.searchWords);
    return { totalNumberOfPages: 1, items: [hit(1, 1, { shortDescription: "Smurfar 10 st" }), hit(2, 1, { shortDescription: "Smurf bok" }), hit(3, 1, { shortDescription: "Schleich häst 13279" })] };
  };
  const r = await discoverSellers({ niche: "smurfar", search, minListings: 1 });
  assert.deepEqual([...new Set(words)], ["smurf"]);
  assert.equal(r.sellers[0].total, 2); // smurfannonserna, inte Schleich-hästen
  assert.equal(r.sellers[0].niche, "smurfar");
});
