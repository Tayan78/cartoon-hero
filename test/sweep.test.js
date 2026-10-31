import { test } from "node:test";
import assert from "node:assert/strict";
import { nicheOf } from "../lib/niches.js";
import { seriesOf } from "../lib/series.js";
import { CAP, fetchAll, resolveEnded, runSweep, sweep, sweepRow, sweepStatus } from "../lib/sweep.js";
import { fakeAppsScript } from "./helpers/apps-script.js";

const hit = (o) => ({ id: 1, shortDescription: "Schleich Tinker sto 13279", sellerId: 42, sellerAlias: "Daisy93", itemType: "PureBuyItNow", buyItNowPrice: 89, bidCount: 0, endDate: "2026-11-05T10:00:00+01:00", itemUrl: "https://www.tradera.com/item/1", categoryId: 1000532, ...o });
const NOW = Date.parse("2026-10-31T03:00:00Z");

test("Serier: märks från rubriken; fantasy och figurer räknas inte till Schleich-djur", () => {
  assert.equal(seriesOf("Schleich Bayala älva med enhörning"), "bayala");
  assert.equal(seriesOf("Schleich Harry Potter Hedwig"), "wizarding_world");
  assert.equal(seriesOf("Schleich indian på häst"), "vilda_vastern");
  assert.equal(seriesOf("Schleich westernhäst"), null); // westernridning är en häst, inte Vilda Västern
  assert.equal(seriesOf("Schleich Horse Club Tinker"), "horse_club");
  assert.equal(nicheOf("Schleich Bayala älva"), null);
  assert.equal(nicheOf("Schleich Snobben"), null);
  assert.equal(nicheOf("Schleich Horse Club Tinker"), "djur");
  assert.equal(nicheOf("Schleich smurf"), "smurfar");
});

test("Sökträff → databasrad: aktiv, auktion såld/osåld, avslutad Köp nu utan status", () => {
  const active = sweepRow(hit(), false, NOW);
  assert.deepEqual(
    [active.id, active.status, active.type, active.price, active.seller, active.seller_id, active.category_id, active.niche, active.source, active.first_seen],
    ["1", "Aktiv", "köp nu", 89, "Daisy93", "42", 1000532, "djur", "sök", "2026-10-31T03:00:00.000Z"],
  );
  const sold = sweepRow(hit({ itemType: "Auction", bidCount: 3, maxBid: 120, nextBid: 125 }), true, NOW);
  assert.deepEqual([sold.status, sold.price, sold.bids, sold.sold_seen], ["Såld", 120, 3, "2026-10-31T03:00:00.000Z"]);
  const unsold = sweepRow(hit({ itemType: "Auction", bidCount: 0, nextBid: 50 }), true, NOW);
  assert.deepEqual([unsold.status, unsold.price, unsold.sold_seen], ["Osåld", 50, undefined]);
  const buyNow = sweepRow(hit(), true, NOW);
  assert.equal(buyNow.status, null); // kollas i annonsdetaljen
  assert.equal(sweepRow(hit({ shortDescription: "Schleich Bayala älva" }), false, NOW).series, "bayala");
});

// Fejkad sökning: 6 000 annonser med pris 0–5 999, filtreras på pris och sidor.
function fakeSearch(n = 6000) {
  const all = Array.from({ length: n }, (_, i) => hit({ id: i + 1, buyItNowPrice: i }));
  const calls = [];
  const search = async (b) => {
    calls.push(b);
    const inBand = all.filter((x) => x.buyItNowPrice >= b.priceMinimum && x.buyItNowPrice <= b.priceMaximum);
    const start = (b.pageNumber - 1) * b.itemsPerPage;
    return { totalNumberOfItems: inBand.length, items: b.pageNumber > 10 ? [] : inBand.slice(start, start + b.itemsPerPage) };
  };
  return { search, calls };
}

test("Prisintervall: delas tills varje del ryms under taket, alla annonser kommer med en gång", async () => {
  const { search, calls } = fakeSearch();
  const stats = { calls: 0, split: 0 };
  const items = await fetchAll("schleich", true, { search, stats });
  assert.equal(items.length, 6000);
  assert.equal(new Set(items.map((i) => i.id)).size, 6000);
  assert.ok(stats.split >= 1); // 800–1 000 000 hade 5 200 träffar → delades
  assert.ok(calls.every((c) => c.itemStatus === "Ended" && c.itemsPerPage === 240 && c.pageNumber <= CAP / 240));
});

test("Avslutade Köp nu: annonsdetaljen avgör såld/osåld", async () => {
  const written = [];
  const get = async (path) => (path.endsWith("/1") ? { status: { gotWinner: true } } : path.endsWith("/2") ? { status: { gotWinner: false } } : Promise.reject(new Error("404")));
  const r = await resolveEnded({ get, unresolved: async () => ["1", "2", "3"], put: async (t, rows) => written.push(...rows), now: NOW });
  assert.deepEqual(r, { checked: 3, resolved: 2, sold: 1, errors: 1 });
  assert.deepEqual(written.map((w) => [w.id, w.status, w.sold_seen ?? null]), [["1", "Såld", "2026-10-31T03:00:00.000Z"], ["2", "Osåld", null]]);
});

test("Hela insamlingen: sökord × aktiva/avslutade, inga dubbletter (avslutad vinner), sedan utfallen", async () => {
  const search = async (b) => {
    if (b.pageNumber > 1 || b.priceMinimum !== 0) return { totalNumberOfItems: 0, items: [] };
    const items = b.itemStatus ? [hit({ id: 5 })] : [hit({ id: 5 }), hit({ id: 6, shortDescription: "Bayala älva" })];
    return { totalNumberOfItems: items.length, items };
  };
  const written = [];
  const out = await sweep({ search, put: async (t, rows) => written.push(...rows), resolve: async () => ({ resolved: 0 }), now: NOW, queries: ["schleich", "bayala"] });
  assert.deepEqual([out.listings, out.active, out.ended], [2, 1, 1]);
  assert.deepEqual(written.map((w) => [w.id, w.status, w.series]), [["5", null, null], ["6", "Aktiv", "bayala"]]);
});

test("Körningens status sparas i Körningar (raden schleich), även vid fel", async () => {
  const gs = fakeAppsScript();
  let t = NOW;
  const clock = () => (t += 1000);
  await runSweep({ store: gs.store, clock, run: async () => ({ listings: 7400, active: 2314, ended: 5086, searches: 60, resolved: { checked: 600, resolved: 590, sold: 300 } }) });
  const st = await sweepStatus({ store: gs.store, now: t });
  assert.deepEqual([st.status, st.running, st.listings], ["Klar", false, 7400]);
  assert.match(st.summary, /2314 aktiva, 5086 avslutade · 60 sökningar · 590 Köp nu-utfall/);
  await assert.rejects(runSweep({ store: gs.store, clock, run: async () => Promise.reject(new Error("Tradera 500")) }));
  assert.equal((await sweepStatus({ store: gs.store, now: t })).status, "Fel: Tradera 500");
});
