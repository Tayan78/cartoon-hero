import { test } from "node:test";
import assert from "node:assert/strict";
import { benchmark, countFigures, findLots, isLot, rankDeals, toLot } from "../lib/lots.js";

test("Parti eller inte", () => {
  assert.ok(isLot("Schleich paket 10 st hästar"));
  assert.ok(isLot("Schleich samling djur"));
  assert.ok(isLot("15 Schleich hästar blandat"));
  assert.ok(!isLot("Schleich Tinker sto 13279"));
  assert.ok(!isLot("Schleich kort 50 st"));
  assert.ok(!isLot("Schleich och Papo paket 10 st"));
});

test("Antal figurer ur rubriken", () => {
  assert.equal(countFigures("Schleich paket 10 st hästar"), 10);
  assert.equal(countFigures("Schleich paket med 8 djur"), 8);
  assert.equal(countFigures("15 Schleich hästar"), 15);
  assert.equal(countFigures("Schleich 6-pack föl"), 6);
  assert.equal(countFigures("Schleich 13279 + 5 st föl"), 5); // modellnumret räknas inte
  assert.equal(countFigures("Schleich 10 st varav 3 föl"), 10); // högsta talet, inte summan
  assert.equal(countFigures("Schleich samling 2010"), null);
  assert.equal(countFigures("Schleich paket blandat"), null);
  assert.equal(countFigures("Schleich 1 st häst"), null); // ett djur är inget parti
});

const item = (o) => ({ id: 1, shortDescription: "Schleich paket 10 st hästar", bidCount: 5, hasBids: true, maxBid: 300, buyItNowPrice: 0, ...o });

test("Normalpris per figur från sålda partier, fynd jämförs mot gruppens median", () => {
  const sold = Array.from({ length: 8 }, (_, i) => toLot(item({ id: i + 1, maxBid: 200 + 20 * i }), true)); // 20–34 kr/figur, hästar
  const unsold = toLot(item({ id: 50, hasBids: false, bidCount: 0, maxBid: 0, buyItNowPrice: 900 }), true);
  const bench = benchmark([...sold, unsold]);
  assert.deepEqual(bench.hästar, { n: 8, p25: 24, median: 27, p75: 31 });
  assert.equal(bench.blandat.n, 0);
  const active = [
    toLot(item({ id: 100, buyItNowPrice: 120, hasBids: false, bidCount: 0, maxBid: 0 }), false), // 12 kr/figur
    toLot(item({ id: 101, buyItNowPrice: 300, hasBids: false, bidCount: 0, maxBid: 0 }), false), // 30 kr/figur
    toLot(item({ id: 102, shortDescription: "Schleich paket blandat", buyItNowPrice: 50 }), false), // utan antal
  ];
  const deals = rankDeals(active, bench);
  assert.deepEqual(deals.map((d) => [d.id, d.per_figure, d.share, d.deal]), [[100, 12, 0.44, true], [101, 30, 1.11, false]]);
  assert.equal(deals[0].price_kind, "köp nu");
});

test("Hämtning: aktiva och avslutade, bara partier, utan dubbletter", async () => {
  const search = async (body) => {
    const ended = body.itemStatus === "Ended";
    const items = ended
      ? Array.from({ length: 8 }, (_, i) => item({ id: 10 + i, maxBid: 250 }))
      : [item({ id: 1, buyItNowPrice: 100, hasBids: false, bidCount: 0 }), item({ id: 2, shortDescription: "Schleich Tinker sto 13279", buyItNowPrice: 60 }), item({ id: 10 })];
    return { totalNumberOfPages: 1, items };
  };
  const r = await findLots({ search });
  assert.deepEqual([r.scanned, r.lots, r.active_lots, r.sold_lots], [10, 9, 1, 8]);
  assert.equal(r.benchmark.hästar.median, 25);
  assert.deepEqual([r.deals[0].id, r.deals[0].per_figure, r.deals[0].deal], [1, 10, true]);
});
