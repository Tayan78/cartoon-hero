import { test } from "node:test";
import assert from "node:assert/strict";
import { addShipping, benchmark, countFigures, findLots, isLot, rankDeals, shippingOf, toLot } from "../lib/lots.js";
import { NICHES, nicheOf } from "../lib/niches.js";

const djur = NICHES.djur;
const smurfar = NICHES.smurfar;

test("Parti eller inte, per nisch", () => {
  assert.ok(isLot("Schleich paket 10 st hästar", djur));
  assert.ok(isLot("Schleich samling djur", djur));
  assert.ok(!isLot("Schleich Tinker sto 13279", djur));
  assert.ok(!isLot("Schleich kort 50 st", djur));
  assert.ok(!isLot("Schleich och Papo paket 10 st", djur));
  assert.ok(!isLot("Schleich smurfar 20 st", djur)); // smurfar hör till Smurfar
  assert.ok(isLot("Schleich smurfar 20 st", smurfar));
  assert.ok(isLot("Smurfar paket blandat", smurfar));
  assert.ok(!isLot("Smurfar böcker 10 st", smurfar));
  assert.ok(!isLot("Smurf gosedjur paket", smurfar));
  assert.ok(!isLot("Schleich staket beige 3 st", djur));
  assert.ok(!isLot("Schleich hinder 5 st", djur));
  assert.ok(!isLot("SMURFARNAS TABLETTASKAR 3 st", smurfar));
});

test("Nisch för en annons", () => {
  assert.equal(nicheOf("Schleich Tinker sto 13279"), "djur");
  assert.equal(nicheOf("Schleich Smurf med blomma 20044"), "smurfar");
  assert.equal(nicheOf("Smurfar 30 st"), "smurfar");
  assert.equal(nicheOf("Lego 2 kg"), null);
});

test("Antal figurer ur rubriken", () => {
  assert.equal(countFigures("Schleich paket 10 st hästar"), 10);
  assert.equal(countFigures("Schleich paket med 8 djur"), 8);
  assert.equal(countFigures("15 Schleich hästar"), 15);
  assert.equal(countFigures("Schleich 6-pack föl"), 6);
  assert.equal(countFigures("Schleich 13279 + 5 st föl"), 5);
  assert.equal(countFigures("Schleich 10 st varav 3 föl"), 10);
  assert.equal(countFigures("30 smurfar blandat"), 30);
  assert.equal(countFigures("Schleich samling 2010"), null);
  assert.equal(countFigures("Schleich paket blandat"), null);
  assert.equal(countFigures("Schleich 1 st häst"), null);
});

const item = (o) => ({ id: 1, shortDescription: "Schleich paket 10 st hästar", bidCount: 5, hasBids: true, maxBid: 300, buyItNowPrice: 0, ...o });

test("Frakt: billigaste fraktsättet räknas in i kr per figur", async () => {
  assert.deepEqual(shippingOf({ shippingOptions: [{ cost: 89 }, { cost: 59 }] }), { shipping: 59, pickup_only: false });
  assert.deepEqual(shippingOf({ shippingOptions: [], acceptsPickup: true }), { shipping: null, pickup_only: true });
  assert.deepEqual(shippingOf({ shippingOptions: [{ cost: 0 }, { cost: 54 }] }), { shipping: 54, pickup_only: false }); // 0 kr räknas inte
  assert.equal(shippingOf({ shippingOptions: [{ cost: 0 }] }).shipping, null);
  const lots = [toLot(item({ id: 1, buyItNowPrice: 100, hasBids: false, bidCount: 0 }), false), toLot(item({ id: 2, shortDescription: "Schleich paket blandat" }), false)];
  assert.equal(lots[0].per_figure, 10); // utan frakt
  const asked = [];
  const { lots: out, fetched } = await addShipping(lots, { get: async (path) => (asked.push(path), { shippingOptions: [{ cost: 60 }] }) });
  assert.deepEqual(asked, ["/v4/items/1"]); // bara partier med antal
  assert.equal(fetched, 1);
  assert.deepEqual([out[0].shipping, out[0].total, out[0].per_figure], [60, 160, 16]);
});

test("Normalpris per figur från sålda partier, fynd jämförs mot gruppens median", () => {
  const sold = Array.from({ length: 8 }, (_, i) => toLot(item({ id: i + 1, maxBid: 200 + 20 * i }), true));
  const unsold = toLot(item({ id: 50, hasBids: false, bidCount: 0, maxBid: 0, buyItNowPrice: 900 }), true);
  const bench = benchmark([...sold, unsold], djur);
  assert.deepEqual(bench.hästar, { n: 8, p25: 24, median: 27, p75: 31 });
  assert.equal(bench.blandat.n, 0);
  const active = [
    toLot(item({ id: 100, buyItNowPrice: 120, hasBids: false, bidCount: 0, maxBid: 0 }), false),
    toLot(item({ id: 101, buyItNowPrice: 300, hasBids: false, bidCount: 0, maxBid: 0 }), false),
    toLot(item({ id: 102, shortDescription: "Schleich paket blandat", buyItNowPrice: 50 }), false),
  ];
  const known = active.map((l) => ({ ...l, shipping: 0 }));
  const deals = rankDeals(known, bench);
  assert.deepEqual(deals.map((d) => [d.id, d.per_figure, d.share, d.deal]), [[100, 12, 0.44, true], [101, 30, 1.11, false]]);
  // Okänd frakt (t.ex. bara avhämtning) blir aldrig fynd, hur billigt det än ser ut.
  assert.equal(rankDeals(active, bench)[0].deal, false);
  // Ett bud är inte slutpriset: auktioner blir aldrig fynd.
  const auction = { ...toLot(item({ id: 103, maxBid: 50, hasBids: false, bidCount: 0 }), false), shipping: 0 };
  assert.equal(auction.price_kind, "bud");
  assert.equal(rankDeals([auction], bench)[0].deal, false);
});

test("Hämtning per nisch: aktiva och avslutade, frakt inräknad, utan dubbletter", async () => {
  const queries = [];
  const search = async (body) => {
    queries.push(body.searchWords);
    const ended = body.itemStatus === "Ended";
    const items = ended
      ? Array.from({ length: 8 }, (_, i) => item({ id: 10 + i, maxBid: 250 }))
      : [item({ id: 1, buyItNowPrice: 100, hasBids: false, bidCount: 0 }), item({ id: 2, shortDescription: "Schleich Tinker sto 13279", buyItNowPrice: 60 }), item({ id: 10 })];
    return { totalNumberOfPages: 1, items };
  };
  const get = async () => ({ shippingOptions: [{ cost: 50 }] });
  const r = await findLots({ niche: "djur", search, get });
  assert.deepEqual([...new Set(queries)], ["schleich"]);
  assert.deepEqual([r.scanned, r.lots, r.active_lots, r.sold_lots, r.shipping_fetched], [10, 9, 1, 8, 9]);
  assert.equal(r.benchmark.hästar.median, 30); // (250 + 50) / 10
  assert.deepEqual([r.deals[0].id, r.deals[0].total, r.deals[0].per_figure, r.deals[0].deal], [1, 150, 15, true]);

  queries.length = 0;
  await findLots({ niche: "smurfar", search: async (b) => (queries.push(b.searchWords), { items: [] }), get });
  assert.deepEqual([...new Set(queries)], ["smurf"]);
});
