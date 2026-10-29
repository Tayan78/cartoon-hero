import { test } from "node:test";
import assert from "node:assert/strict";
import { addShipping, benchmark, buyerFee, checkLot, countFigures, findLots, isLot, maxOrderFor, rankDeals, shippingOf, singleStats, toLot, withBuyerFee } from "../lib/lots.js";
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
  assert.equal(lots[0].per_figure, 11); // utan frakt: 100 + köparskydd 7 = 107 kr / 10
  const asked = [];
  const { lots: out, fetched } = await addShipping(lots, { get: async (path) => (asked.push(path), { shippingOptions: [{ cost: 60 }] }) });
  assert.deepEqual(asked, ["/v4/items/1"]); // bara partier med antal
  assert.equal(fetched, 1);
  assert.deepEqual([out[0].shipping, out[0].buyer_fee, out[0].total, out[0].per_figure], [60, 7, 167, 17]); // 100 + köparskydd 7 (bara på priset) + frakt 60
});

test("Normalpris per figur från sålda partier, fynd jämförs mot gruppens median", () => {
  const sold = Array.from({ length: 8 }, (_, i) => toLot(item({ id: i + 1, maxBid: 200 + 20 * i }), true));
  const unsold = toLot(item({ id: 50, hasBids: false, bidCount: 0, maxBid: 0, buyItNowPrice: 900 }), true);
  const bench = benchmark([...sold, unsold], djur);
  assert.deepEqual(bench.hästar, { n: 8, p25: 25, median: 29, p75: 33 }); // inkl. köparskydd
  assert.equal(bench.blandat.n, 0);
  const active = [
    toLot(item({ id: 100, buyItNowPrice: 120, hasBids: false, bidCount: 0, maxBid: 0 }), false),
    toLot(item({ id: 101, buyItNowPrice: 300, hasBids: false, bidCount: 0, maxBid: 0 }), false),
    toLot(item({ id: 102, shortDescription: "Schleich paket blandat", buyItNowPrice: 50 }), false),
  ];
  const known = active.map((l) => ({ ...l, shipping: 0 }));
  const deals = rankDeals(known, bench);
  assert.deepEqual(deals.map((d) => [d.id, d.per_figure, d.share, d.deal]), [[100, 13, 0.45, true], [101, 32, 1.1, false]]);
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
  assert.ok(queries.includes("schleich st") && queries.includes("schleich djur"));
  assert.ok(!queries.includes("schleich")); // ingen bred sökning som kapas
  assert.deepEqual([r.scanned, r.lots, r.active_lots, r.sold_lots, r.shipping_fetched], [10, 9, 1, 8, 9]); // samma annonser i alla sökningar = inga dubbletter
  assert.equal(r.benchmark.hästar.median, 32); // (250 + köparskydd 15 + frakt 50) / 10
  assert.deepEqual([r.deals[0].id, r.deals[0].total, r.deals[0].per_figure, r.deals[0].deal], [1, 157, 16, true]); // 100 + köparskydd 7 + frakt 50

  queries.length = 0;
  await findLots({ niche: "smurfar", search: async (b) => (queries.push(b.searchWords), { items: [] }), get });
  assert.ok(queries.every((q) => /^smurf/.test(q)));
});

test("Sökning som har fler sidor än vi hämtar flaggas", async () => {
  const search = async (body) => ({ totalNumberOfPages: body.searchWords === "schleich djur" && !body.itemStatus ? 25 : 1, items: [] });
  const r = await findLots({ niche: "djur", search, get: async () => ({}) });
  assert.deepEqual(r.truncated, ["schleich djur"]);
});

test("Det verkliga partiet '42 st Schleich-djur.': filtren godkänner det, kontrollen visar vilka sökningar som hittar det", async () => {
  const title = "42 st Schleich-djur.";
  assert.ok(isLot(title, djur));
  assert.equal(countFigures(title), 42);
  const bodies = [];
  // Låtsas att sökningen bara hittar den med bindestreck eller inom kategorin.
  const search = async (body) => {
    bodies.push(body);
    const hit = body.searchWords === "schleich-djur" || (body.categoryId === 1000532 && body.searchWords === "st");
    return { totalNumberOfPages: 1, items: hit ? [{ id: 758257789, shortDescription: title }] : [] };
  };
  const get = async () => ({ id: 758257789, shortDescription: title, endDate: "2099-11-07T20:47:00Z", shippingOptions: [{ cost: 59 }] });
  const r = await checkLot("https://www.tradera.com/item/1000532/758257789/42-st-schleich-djur-", { search, get });
  assert.deepEqual([r.id, r.niche, r.count, r.is_lot, r.shipping.shipping], ["758257789", "djur", 42, true, 59]);
  assert.deepEqual(r.found.filter((f) => f.page).map((f) => f.query), ["schleich-djur", "st i kategori 1000532"]);
  assert.ok(bodies.some((b) => b.categoryId === 1000532));
  await assert.rejects(checkLot("hej", { search, get }), /Tradera-länk/);
});

test("Auktion: värde, budtak och under/över gränsen", () => {
  const bench = { all: { n: 20, median: 38 }, hästar: { n: 0 }, blandat: { n: 20, median: 38 } };
  const lot = (o) => ({ ...toLot(item({ id: 9, shortDescription: "42 st Schleich-djur.", maxBid: 2, bidCount: 1, buyItNowPrice: 0 }), false), shipping: 59, ...o });
  const [a] = rankDeals([lot({})], bench);
  assert.equal(a.price_kind, "bud");
  assert.equal(a.value, 1596); // 42 × 38
  assert.equal(a.max_bid, 853); // 60 % av 1596 = 957 − frakt 59 = 898 → bud 853 + köparskydd 45
  assert.equal(a.under_max, true);
  assert.equal(a.deal, false); // auktioner är inte "Köp nu-fynd"
  const [high] = rankDeals([lot({ price: 1000 })], bench);
  assert.equal(high.under_max, false);
  const [unknown] = rankDeals([lot({ shipping: null })], bench);
  assert.deepEqual([unknown.max_bid, unknown.under_max], [null, false]);
});

test("Lågt bud på stort parti (0 kr per figur efter avrundning) försvinner inte ur listan", () => {
  const bench = { all: { n: 20, median: 38 }, hästar: { n: 0 }, blandat: { n: 20, median: 38 } };
  const l = toLot(item({ id: 9, shortDescription: "42 st Schleich-djur.", maxBid: 2, bidCount: 1, buyItNowPrice: 0 }), false);
  assert.equal(l.per_figure, 0);
  assert.equal(rankDeals([l], bench).length, 1);
});

// Sålda/osålda enskilda figurer i Marknad (som från sheetRead).
const row = (title, status, pris, nisch = "djur") => ({ Rubrik: title, Status: status, Pris: pris, Nisch: nisch });
const marketRows = [
  ...Array.from({ length: 10 }, (_, i) => row("Schleich Tinker sto 13279", "Såld", 50 + 5 * i)), // 50–95, median 72,5 → 73
  ...Array.from({ length: 10 }, () => row("Schleich Tinker sto 13279", "Osåld", 89)),
  ...Array.from({ length: 12 }, (_, i) => row("Schleich Lejon 14726", "Såld", 40 + 5 * i)), // median 67,5 → 68
  row("Schleich paket 10 st hästar", "Såld", 500), // parti – räknas inte
  row("Schleich staket", "Såld", 30), // tillbehör – räknas inte
  row("Smurf med blomma", "Såld", 25, "smurfar"), // annan nisch
];

test("Styckförsäljning: median, netto efter avgift och säljgrad per grupp", () => {
  const s = singleStats(marketRows, djur, { fee_percent: 10, fee_fixed: 0 });
  assert.deepEqual([s.hästar.n, s.hästar.median, s.hästar.net, s.hästar.sell_through], [10, 73, 66, 50]);
  assert.deepEqual([s.blandat.n, s.blandat.median, s.blandat.net, s.blandat.sell_through], [12, 68, 61, 100]);
  assert.equal(s.all.n, 22);
});

test("Partiets värde styckvis: köpreglerna ger betala högst, budtak och grönt/gult/rött", () => {
  const singles = singleStats(marketRows, djur, { fee_percent: 10, fee_fixed: 0 });
  const bench = { all: { n: 0 }, hästar: { n: 0 }, blandat: { n: 0 } };
  const auction = { ...toLot(item({ id: 9, shortDescription: "42 st Schleich-djur.", maxBid: 2, bidCount: 1 }), false), shipping: 59 };
  const [a] = rankDeals([auction], bench, { singles });
  assert.equal(a.basis, "styckvis");
  assert.equal(a.value, 42 * 61); // 2 562 kr netto styckvis
  assert.equal(a.pay_max, 1281); // grön vid 2×
  assert.equal(a.max_bid, 1162); // 1281 − frakt 59 = 1222 → bud 1162 + köparskydd 60
  assert.equal(a.under_max, true);
  const buyNow = (price) => withShipping(toLot(item({ id: 10, shortDescription: "Schleich paket 10 st hästar", hasBids: false, bidCount: 0, maxBid: 0, buyItNowPrice: price }), false), 59);
  const [cheap] = rankDeals([buyNow(200)], bench, { singles }); // 259 kr för 660 kr netto = 2,5×
  assert.deepEqual([cheap.color, cheap.deal, cheap.multiple], ["green", true, 2.5]);
  const [mid] = rankDeals([buyNow(400)], bench, { singles }); // 459 kr = 1,4×
  assert.deepEqual([mid.color, mid.deal], ["yellow", false]);
  const [dear] = rankDeals([buyNow(700)], bench, { singles });
  assert.equal(dear.color, "red");
});

test("Hämtning läser styckförsäljningen från Marknad; utan den används partipriset", async () => {
  const search = async (body) => ({ totalNumberOfPages: 1, items: body.itemStatus ? [] : [item({ id: 1, buyItNowPrice: 200, hasBids: false, bidCount: 0, maxBid: 0 })] });
  const get = async () => ({ shippingOptions: [{ cost: 59 }] });
  const reads = [];
  const store = async (action, p) => (reads.push(p.filter.equals), { ok: true, rows: marketRows.filter((r) => r.Status === p.filter.equals) });
  const r = await findLots({ niche: "djur", search, get, store });
  assert.deepEqual(reads.sort(), ["Osåld", "Såld"]);
  assert.equal(r.singles.hästar.n, 10);
  assert.deepEqual([r.deals[0].basis, r.deals[0].deal], ["styckvis", true]);
  const fallback = await findLots({ niche: "djur", search, get, store: async () => ({ ok: false }) });
  assert.equal(fallback.singles, null);
  assert.equal(fallback.deals[0].basis, "partier");
});

function withShipping(lot, shipping) {
  const total = lot.price + shipping;
  return { ...lot, shipping, total, per_figure: Math.round(total / lot.count) };
}

test("Nischerna hålls isär: sålda smurfar räknas aldrig in i Schleich-djur, och tvärtom", () => {
  const rows = [
    ...Array.from({ length: 10 }, () => row("Schleich Tinker sto 13279", "Såld", 70)),
    ...Array.from({ length: 10 }, () => row("Schleich Smurf med blomma 20044", "Såld", 20, "smurfar")),
    row("Schleich Smurf fiskare", "Såld", 15, "djur"), // fel nisch i Sheet – rubriken avgör ändå
    row("Smurf i båt", "Såld", 18, ""), // utan nisch i Sheet
  ];
  const d = singleStats(rows, djur);
  assert.equal(d.all.n, 10);
  assert.equal(d.all.median, 70);
  const s = singleStats(rows, smurfar);
  assert.equal(s.all.n, 11); // 10 märkta smurfar + den utan nisch; den felmärkta räknas inte i någon
  assert.equal(s.all.median, 20);
});

test("Auktion med Köp nu-pris: räknas som auktion (utropet), Köp nu visas bredvid och blir fynd om det är under gränsen", () => {
  const singles = singleStats(marketRows, djur, { fee_percent: 10, fee_fixed: 0 });
  const bench = { all: { n: 0 }, hästar: { n: 0 }, blandat: { n: 0 } };
  // Verkligt fall: "Stort Schleich-paket 11 st", utrop 149 kr, Köp nu 399 kr, frakt 59 kr.
  const raw = { id: 77, shortDescription: "Stort Schleich-paket 11 st – Äldre samlarfigurer 2001-2006", itemType: "Auction", bidCount: 0, hasBids: false, maxBid: 0, nextBid: 149, buyItNowPrice: 399 };
  const lot = toLot(raw, false);
  assert.deepEqual([lot.price_kind, lot.price, lot.buy_now], ["bud", 149, 399]);
  const withShip = { ...lot, shipping: 59, total: 208 };
  const [a] = rankDeals([withShip], bench, { singles }); // 11 × 61 = 671 kr netto, betala högst 335
  assert.deepEqual([a.value, a.pay_max, a.max_bid, a.under_max], [671, 335, 261, true]); // 261 + köparskydd 15 + frakt 59 = 335
  assert.deepEqual([a.buy_now_total, a.buy_now_ok, a.deal], [480, false, false]); // 399 + köparskydd 22 + frakt 59 – för dyrt
  const [cheap] = rankDeals([{ ...withShip, buy_now: 249 }], bench, { singles }); // 308 kr ≤ 335
  assert.deepEqual([cheap.buy_now_ok, cheap.deal, cheap.price_kind], [true, true, "bud"]);
  // Ren Köp nu-annons är fortfarande Köp nu.
  assert.equal(toLot({ ...raw, itemType: "PureBuyItNow", nextBid: 0 }, false).price_kind, "köp nu");
});

test("Köparskydd: 2 kr + 5 % av priset (inte frakten), max 499 kr, och budtaket ryms inkl. avgiften", () => {
  assert.equal(buyerFee(149), 9); // Traderas exempel: 149 kr → 158 kr med köparskydd
  assert.equal(buyerFee(2), 2); // 2 kr → 4 kr
  assert.equal(buyerFee(20000), 499); // tak
  assert.equal(buyerFee(0), 0);
  for (const budget of [50, 335, 957, 1281, 12000]) {
    const order = maxOrderFor(budget);
    assert.ok(withBuyerFee(order) <= budget, `budget ${budget}`);
    assert.ok(withBuyerFee(order + 1) > budget, `budget ${budget} +1`);
  }
});
