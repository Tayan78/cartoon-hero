import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKET_HEADERS, SELLER_HEADERS, collectSeller, discoverSellers, listSellers, marketRow, mergeMarketRow, runStatus, runStep, startRun, watchSeller } from "../lib/marketdata.js";
import { fakeAppsScript } from "./helpers/apps-script.js";

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

test("Insamling mot riktiga Code.gs: nya rader, prissänkning, såld, rensning och säljarens siffror", async () => {
  const gs = fakeAppsScript();
  const seller = { id: "42", alias: "Daisy93", total: 196 };
  await watchSeller(seller, true, { store: gs.store, url: "https://app/api/marketdata", now: Date.parse("2026-10-28T10:00:00Z") });
  assert.deepEqual(gs.triggers.map((t) => t.getHandlerFunction()), ["nightly"]);
  assert.equal(gs.props.NIGHTLY_URL, "https://app/api/marketdata");

  const item = (id, o = {}) => ({ id, title: "Schleich Tinker sto", number: "13279", number_source: "text", type: "köp nu", price: 89, bids: 0, shipping: 49, condition: "", start: "2026-10-01T10:00:00.000Z", end: "2026-10-31T10:00:00.000Z", days: 27, restarts: 0, url: "u", text: "Schleich 13279", sold: false, ended: false, ...o });
  let skipped;
  const night = (items) => async (alias, opts) => {
    skipped = [...opts.skipDetail];
    return { alias: "Daisy93", user_id: "42", detail: { fetched: 0, errors: 0 }, items };
  };
  const r1 = await collectSeller({ alias: "Daisy93", user_id: "42" }, { store: gs.store, fetchItems: night([item(1), item(2, { number: "", text: "" })]), now: Date.parse("2026-10-28T03:00:00Z") });
  assert.deepEqual([r1.added, r1.updated, r1.removed], [2, 0, 0]);

  // Gamla rader utan Schleich för samma säljare (från versionen utan filter) + annan säljare.
  await gs.store("sheetUpsert", { sheet: "Marknad", headers: MARKET_HEADERS, key: "Annons-ID", rows: [{ "Annons-ID": "90", "Säljar-ID": "42", Rubrik: "Lego 2 kg" }, { "Annons-ID": "91", "Säljar-ID": "77", Rubrik: "Playmobil" }] });

  // Natt 2: annons 1 sänkt till 69 och såld (utan text i svaret), ny annons 3.
  const r2 = await collectSeller({ alias: "Daisy93", user_id: "42" }, { store: gs.store, fetchItems: night([item(1, { price: 69, sold: true, ended: true, number: "", text: "" }), item(2, { number: "", text: "" }), item(3, { price: 50 })]), now: Date.parse("2026-10-29T03:00:00Z") });
  assert.deepEqual([r2.added, r2.updated, r2.removed], [1, 2, 1]);
  assert.deepEqual(skipped.sort(), ["1"]); // annons 1 har redan text/nummer

  const rows = Object.fromEntries(gs.table("Marknad").map((r) => [String(r["Annons-ID"]), r]));
  assert.deepEqual(Object.keys(rows).sort(), ["1", "2", "3", "91"]);
  const a = rows["1"];
  assert.deepEqual([a.Status, a.Pris, a["Första pris"], a["Lägsta pris"], a.Prisändringar, a.Modellnummer, a.Text], ["Såld", 69, 89, 69, 1, "13279", "Schleich 13279"]);
  assert.equal(a["Såld upptäckt"], "2026-10-29T03:00:00.000Z");
  assert.equal(a["Först sedd"], "2026-10-28T03:00:00.000Z");

  const [s] = await listSellers({ store: gs.store });
  assert.deepEqual([s.alias, s.watched, s.in_db, s.sold_in_db, s.collected], ["Daisy93", true, 3, 1, "2026-10-29T03:00:00.000Z"]);

  await watchSeller(seller, false, { store: gs.store, url: "https://app/api/marketdata" });
  assert.equal(gs.triggers.length, 0);
});

test("Auktioner: bud räknas inte som prisändring", () => {
  const old = { Pris: 50, "Lägsta pris": 50, Prisändringar: 0, Status: "Aktiv" };
  const row = mergeMarketRow(old, { id: "1", type: "auktion", price: 80, status: "Aktiv" }, "t");
  assert.equal(row.Prisändringar, undefined);
  assert.equal(row["Lägsta pris"], undefined);
  assert.equal(mergeMarketRow(old, { id: "1", type: "köp nu", price: 40, status: "Aktiv" }, "t").Prisändringar, 1);
});

test("Bakgrundskörning: en i taget, äldst först, fel på säljaren, status och bara vissa säljare", async () => {
  const gs = fakeAppsScript();
  for (const [id, alias] of [["1", "A"], ["2", "B"], ["3", "C"]]) await watchSeller({ id, alias }, true, { store: gs.store, url: "u" });
  await gs.store("sheetUpsert", { sheet: "Säljare", headers: SELLER_HEADERS, key: "Säljar-ID", rows: [{ "Säljar-ID": "1", "Senast insamlad": "2026-10-27T03:00:00Z" }] });
  const order = [];
  const collect = async ({ user_id }) => {
    order.push(user_id);
    if (user_id === "2") throw new Error("Tradera 500: fel");
  };
  const now = Date.parse("2026-10-29T06:00:00Z");
  let t = now;
  const clock = () => (t += 20_000); // två säljare hinns per steg (50 s)

  const run = await startRun(null, { store: gs.store, now });
  assert.equal(run.started, true);
  assert.equal((await startRun(null, { store: gs.store, now })).started, false); // en körning åt gången
  assert.equal((await runStatus({ store: gs.store, now })).running, true);

  const first = await runStep(run.state, { store: gs.store, collect, clock });
  assert.deepEqual([first.ran, first.more], [2, true]);
  const mid = await runStatus({ store: gs.store, now: t });
  assert.deepEqual([mid.running, mid.done, mid.left], [true, 2, 1]);
  const second = await runStep(first.state, { store: gs.store, collect, clock });
  assert.deepEqual([second.ran, second.more], [1, false]);
  assert.deepEqual(order, ["2", "3", "1"]); // aldrig insamlade först, sedan äldst
  const end = await runStatus({ store: gs.store, now: t });
  assert.deepEqual([end.running, end.status], [false, "Klar"]);
  assert.equal((await listSellers({ store: gs.store })).find((s) => s.id === "2").error, "Tradera 500: fel");

  // Bara en säljare (Samla nu).
  order.length = 0;
  const one = await startRun(["3"], { store: gs.store, now: t });
  const step = await runStep(one.state, { store: gs.store, collect, clock });
  assert.deepEqual([order, step.more], [["3"], false]);

  // Stannad körning (inget livstecken på 3 min) räknas inte som pågående.
  await startRun(null, { store: gs.store, now: t });
  const stale = await runStatus({ store: gs.store, now: t + 4 * 60 * 1000 });
  assert.deepEqual([stale.running, stale.status], [false, "Avbruten"]);
  assert.equal((await startRun(null, { store: gs.store, now: t + 4 * 60 * 1000 })).started, true);
});

test("Nischer: smurfar behålls och märks, annat tas bort, säljarens nischer sparas", async () => {
  const gs = fakeAppsScript();
  await watchSeller({ id: "5", alias: "SmurfSäljaren", niche: "smurfar" }, true, { store: gs.store, url: "u" });
  await watchSeller({ id: "5", alias: "SmurfSäljaren", niche: "djur" }, true, { store: gs.store, url: "u" });
  assert.deepEqual((await listSellers({ store: gs.store }))[0].niches, ["smurfar", "djur"]);
  const it = (id, title) => ({ id, title, number: "", number_source: "", type: "köp nu", price: 30, bids: 0, shipping: 49, condition: "", start: "", end: "", days: 1, restarts: 0, url: "u", text: "", sold: false, ended: false });
  await gs.store("sheetUpsert", { sheet: "Marknad", headers: MARKET_HEADERS, key: "Annons-ID", rows: [{ "Annons-ID": "9", "Säljar-ID": "5", Rubrik: "Barbie docka" }] });
  await collectSeller({ alias: "SmurfSäljaren", user_id: "5" }, { store: gs.store, fetchItems: async () => ({ alias: "SmurfSäljaren", user_id: "5", detail: {}, items: [it(1, "Smurf med blomma Schleich 20044"), it(2, "Schleich Tinker sto 13279")] }) });
  const rows = Object.fromEntries(gs.table("Marknad").map((r) => [String(r["Annons-ID"]), r.Nisch]));
  assert.deepEqual(rows, { 1: "smurfar", 2: "djur" });
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
