import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLot, fetchLegoLots, legoCalc, legoReport, legoStats, percentile, sizeOf, toLot } from "../lib/lego.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const item = (o) => ({ id: 1, shortDescription: "Blandat Lego 5 kg", isEnded: true, hasBids: true, bidCount: 4, maxBid: 450, endDate: daysAgo(5), ...o });

test("Urval: Duplo, andra märken, bara figurer och oöppnat sorteras bort; figurer/tema märks", () => {
  assert.equal(classifyLot("Lego Duplo 5 kg").exclude, "Duplo");
  assert.equal(classifyLot("Mega Bloks lego-kompatibla 3 kg").exclude, "inte Lego");
  assert.equal(classifyLot("Lego endast minifigurer 0,5 kg").exclude, "bara figurer");
  assert.equal(classifyLot("Lego oöppnad 2 kg").exclude, "oöppnat/nytt");
  assert.deepEqual(classifyLot("Blandat LEGO 14 kg"), { exclude: null, figs: false });
  assert.equal(classifyLot("13,5 kg LEGO + 1,1 kg Minifigurer – Star Wars").figs, true);
  assert.equal(classifyLot("Lego 4 kg Ninjago").figs, true);
});

test("Parti: sålt bara med bud, kilopris, vikt krävs", () => {
  const sold = toLot(item({}));
  assert.deepEqual([sold.sold, sold.price, sold.kg, sold.kr_per_kg, sold.exclude], [true, 450, 5, 90, null]);
  const unsold = toLot(item({ hasBids: false, bidCount: 0, maxBid: 0, buyItNowPrice: 681 }));
  assert.deepEqual([unsold.sold, unsold.price, unsold.kr_per_kg], [false, 681, null]);
  assert.equal(toLot(item({ shortDescription: "Lego blandat" })).exclude, "vikt saknas");
  assert.equal(toLot(item({ shortDescription: "Playmobil 5 kg" })), null); // inte Lego i rubriken
});

test("Percentiler och storlekar", () => {
  assert.equal(percentile([50, 90, 100, 110, 200], 0.5), 100);
  assert.equal(percentile([50, 90, 100, 110, 200], 0.25), 90);
  assert.equal(percentile([80, 100], 0.5), 90);
  assert.equal(percentile([], 0.5), null);
  assert.deepEqual([sizeOf(1), sizeOf(3), sizeOf(9.9), sizeOf(30)], ["1–3 kg", "3–10 kg", "3–10 kg", "10 kg+"]);
});

test("Statistik: perioder, med/utan figurer, bortsorterade och osålda räknas inte", () => {
  const lots = [
    toLot(item({ id: 1, maxBid: 400, endDate: daysAgo(5) })), // 80
    toLot(item({ id: 2, maxBid: 500, endDate: daysAgo(20) })), // 100
    toLot(item({ id: 3, maxBid: 600, endDate: daysAgo(60) })), // 120
    toLot(item({ id: 4, shortDescription: "Lego 2 kg minifigurer", maxBid: 400, endDate: daysAgo(10) })), // 200, figurer
    toLot(item({ id: 5, shortDescription: "Lego Duplo 5 kg", maxBid: 900 })),
    toLot(item({ id: 6, hasBids: false, bidCount: 0, maxBid: 0, buyItNowPrice: 999 })),
  ];
  const s = legoStats(lots, NOW);
  assert.deepEqual(s.d30.plain, { n: 2, p25: 85, median: 90, p75: 95 });
  assert.equal(s.d90.plain.median, 100);
  assert.equal(s.d90.figs.median, 200);
  assert.equal(s.d90.sizes["3–10 kg"].n, 3);
  const r = legoReport(lots, NOW);
  assert.deepEqual([r.total, r.sold, r.unsold, r.used], [6, 5, 1, 4]);
  assert.deepEqual(r.excluded, { Duplo: 1 });
  assert.equal(r.lots[0].id, 1); // nyast först
});

test("Hämtning: alla sidor för varje sökord, utan dubbletter", async () => {
  const calls = [];
  const search = async (body) => {
    calls.push(body);
    assert.equal(body.itemStatus, "Ended");
    const base = body.searchWords === "lego kg" ? 0 : 100;
    return { totalNumberOfPages: body.searchWords === "lego kg" ? 2 : 1, items: [item({ id: base + body.pageNumber }), item({ id: 1 })] };
  };
  const { lots, pages } = await fetchLegoLots({ queries: ["lego kg", "lego kilo"], search });
  assert.equal(calls.length, 3);
  assert.deepEqual(lots.map((l) => l.id).sort((a, b) => a - b), [1, 2, 101]);
  assert.equal(pages.length, 3);
});

test("Räknare: kilopris × vikt − avgift → samma köpregler som Skanna", () => {
  const r = legoCalc({ weight: 10, price: 400, kr_per_kg: 90, settings: DEFAULT_SETTINGS });
  assert.deepEqual([r.sale, r.fees, r.net], [900, 90, 810]);
  assert.equal(r.decision.color, "green"); // vinst 410, multipel 2,0×
  const unknown = legoCalc({ weight: 10, price: 0, kr_per_kg: 90, settings: DEFAULT_SETTINGS });
  assert.equal(unknown.decision.known, false);
  assert.match(unknown.decision.verdict, /Betala inte mer än/);
  assert.equal(legoCalc({ weight: 0, kr_per_kg: 90, settings: DEFAULT_SETTINGS }), null);
});
