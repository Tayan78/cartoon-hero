import { test } from "node:test";
import assert from "node:assert/strict";
import { lensTraderaIds, mergeListings, parseSearch, toItemListing, toListing, traderaQuery, traderaSearch } from "../lib/tradera.js";

const item = (o) => ({ id: 1, shortDescription: "Schleich 13695 Pinto", buyItNowPrice: 0, nextBid: 0, itemUrl: "https://www.tradera.com/item/1/1/x", isEnded: false, ...o });

test("Tradera-annons: köp nu-pris före nästa bud, avslutade och prislösa tas bort", () => {
  assert.equal(toListing(item({ buyItNowPrice: 129, nextBid: 50 })).price, 129);
  const bid = toListing(item({ nextBid: 55, bidCount: 3 }));
  assert.equal(bid.price, 55);
  assert.equal(bid.price_type, "bud");
  assert.equal(bid.bids, 3);
  assert.equal(toListing(item({ buyItNowPrice: 129, isEnded: true })), null);
  assert.equal(toListing(item({})), null);
  // Utan itemUrl byggs adressen av id. PascalCase (som SOAP) fungerar också.
  assert.equal(toListing({ Id: 7, ShortDescription: "Häst", BuyItNowPrice: 99 }).url, "https://www.tradera.com/item/7");
  assert.equal(parseSearch({ items: [item({ buyItNowPrice: 10 }), item({ isEnded: true, buyItNowPrice: 5 })] }).length, 1);
});

test("Tradera-sökning: rätt adress och nycklar, numret filtrerar bort andra modeller", async () => {
  process.env.TRADERA_APP_ID = "7482";
  process.env.TRADERA_APP_KEY = "nyckel";
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, headers: init.headers };
    return new Response(JSON.stringify({
      totalNumberOfItems: 3,
      items: [
        item({ id: 1, buyItNowPrice: 129 }),
        item({ id: 2, shortDescription: "Schleich pinto föl 13803", buyItNowPrice: 49, itemUrl: "https://www.tradera.com/item/1/2/y" }),
        item({ id: 3, shortDescription: "schleich 13695 häst", nextBid: 60, itemUrl: "https://www.tradera.com/item/1/3/z" }),
      ],
    }), { status: 200 });
  };
  try {
    const r = await traderaSearch({ queries: ["Schleich 13695"], article: "13695" });
    assert.equal(seen.url, "https://api.tradera.com/v4/search?query=Schleich+13695");
    assert.equal(seen.headers["X-App-Id"], "7482");
    assert.equal(seen.headers["X-App-Key"], "nyckel");
    assert.deepEqual(r.listings.map((l) => l.price), [129, 60]);
    assert.equal(r.matched_number, true);
    assert.equal(r.total, 3);

    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
    await assert.rejects(traderaSearch({ queries: ["x"] }), /Fel Tradera-nycklar/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("sökord: märke + bekräftat nummer, sedan namnet utan nummer", () => {
  assert.deepEqual(traderaQuery({ item: { brand: "Schleich", name: "Schleich Knabstrupper sto (13910)" }, article: { number: "13910", verified: true } }), {
    queries: ["Schleich 13910", "Schleich Knabstrupper sto"], article: "13910", words: ["Knabstrupper"],
  });
  assert.deepEqual(traderaQuery({ item: { brand: "Schleich", name: "Schleich Pinto" }, article: { number: "13803", verified: false } }), {
    queries: ["Schleich Pinto"], article: "", words: ["Pinto"],
  });
});

test("inga träffar på numret: söker på namnet och behåller bara samma modell", async () => {
  process.env.TRADERA_APP_ID = "7482";
  process.env.TRADERA_APP_KEY = "nyckel";
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const q = new URL(url).searchParams.get("query");
    asked.push(q);
    const items = q === "Schleich 13910" ? [] : [
      item({ id: 1, shortDescription: "Schleich häst Knabstrupper", buyItNowPrice: 70 }),
      item({ id: 2, shortDescription: "Schleich Hannoveraner sto", buyItNowPrice: 40, itemUrl: "https://www.tradera.com/item/1/2/y" }),
    ];
    return new Response(JSON.stringify({ totalNumberOfItems: items.length, items }), { status: 200 });
  };
  try {
    const r = await traderaSearch({ queries: ["Schleich 13910", "Schleich Knabstrupper sto"], article: "13910", words: ["Knabstrupper"] });
    assert.deepEqual(asked, ["Schleich 13910", "Schleich Knabstrupper sto"]);
    assert.equal(r.query, "Schleich Knabstrupper sto");
    assert.deepEqual(r.listings.map((l) => l.price), [70]);
    assert.equal(r.matched_number, false);
    assert.deepEqual(r.tried.map((t) => t.found), [0, 2]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Tradera först, dubbletter tas bort", () => {
  const t = [{ url: "https://www.tradera.com/item/1?utm=x", price_sek: 90 }];
  const lens = [{ url: "https://www.tradera.com/item/1", price_sek: 95 }, { url: "https://www.ebay.de/itm/2", price_sek: 120 }];
  assert.deepEqual(mergeListings(t, lens).map((l) => l.price_sek), [90, 120]);
});

test("Lens-träffarnas Tradera-länkar: lotter och andra modellnummer bort (riktiga träffar för Tinkersto 13279)", () => {
  const matches = [
    ["Schleich häst, sto - 2003 - Tinker | Köp på Tradera (742405778)", "https://www.tradera.com/item/2944/742405778/schleich-hast-sto-2003-tinker"],
    ["Schleich hästar, 3 stycken | Köp på Tradera (750449807)", "https://www.tradera.com/item/1000532/750449807/schleich-hastar-3-stycken"],
    ["Se produkter som liknar Schleich Tinker Hingst 13831 .. på ...", "https://www.tradera.com/item/1000532/739249852/schleich-tinker-hingst-13831-hast"],
    ["Schleich hästar - paket | Köp på Tradera (751997900)", "https://www.tradera.com/item/1000532/751997900/schleich-hastar-paket"],
    ["Schleich 2003 Tinker Mare Retired Collectible Figure 13279 ...", "https://www.ebay.co.uk/itm/115982413471"],
  ].map(([title, link]) => ({ title, link, platform: /tradera/.test(link) ? "Tradera" : "eBay" }));
  assert.deepEqual(lensTraderaIds(matches, "13279").map((x) => x.id), ["742405778"]);
});

test("enskilt objekt: pågående = till salu, avslutat med bud = såld, utan bud = bort", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const link = "https://www.tradera.com/item/2944/742405778/x";
  const base = { id: 742405778, shortDescription: "Schleich häst, sto - 2003 - Tinker" };
  const active = toItemListing({ ...base, endDate: "2026-10-30T18:00:00Z", buyItNowPrice: 99, totalBids: 0 }, link, now);
  assert.deepEqual([active.price, active.sold, active.url], [99, false, link]);
  const sold = toItemListing({ ...base, endDate: "2026-10-20T18:00:00Z", maxBid: 85, totalBids: 4 }, link, now);
  assert.deepEqual([sold.price, sold.sold, sold.price_type], [85, true, "såld"]);
  assert.equal(toItemListing({ ...base, endDate: "2026-10-20T18:00:00Z", maxBid: 0, totalBids: 0 }, link, now), null);
});

test("namnord matchar utan mellanslag: 'Tinkersto' hittar 'Tinker sto'", async () => {
  process.env.TRADERA_APP_ID = "7482";
  process.env.TRADERA_APP_KEY = "nyckel";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ items: [item({ shortDescription: "Schleich Tinker sto svart/vit", buyItNowPrice: 90 }), item({ id: 2, shortDescription: "Schleich Tinker hingst", buyItNowPrice: 80, itemUrl: "https://www.tradera.com/item/1/2/y" })] }), { status: 200 });
  try {
    const r = await traderaSearch({ queries: ["Schleich Tinkersto"], words: ["Tinkersto"] });
    assert.deepEqual(r.listings.map((l) => l.price), [90]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

import { endedLot, parseWeightKg, probeEndedSearch, summarizeLots } from "../lib/tradera.js";

test("Vikt ur rubrik eller text: kg, kilo och gram", () => {
  assert.equal(parseWeightKg("Lego blandat 5 kg"), 5);
  assert.equal(parseWeightKg("LEGO bitar 2,3 kilo med figurer"), 2.3);
  assert.equal(parseWeightKg("Lego 1.5kg"), 1.5);
  assert.equal(parseWeightKg("Legobitar ca 800 g"), 0.8);
  assert.equal(parseWeightKg("<p>Vikt: 3 kilogram</p>"), 3);
  assert.equal(parseWeightKg("Lego 6 st minifigurer"), null);
  assert.equal(parseWeightKg("Lego 5 g"), null); // för litet för ett parti
});

test("Avslutat parti: slutpris från högsta bud, kilopris", () => {
  const lot = endedLot({ id: 7, shortDescription: "Lego 4 kg blandat", isEnded: true, hasBids: true, bidCount: 12, maxBid: 360, endDate: "2026-10-20T19:00:00Z" });
  assert.equal(lot.sold, true);
  assert.equal(lot.price, 360);
  assert.equal(lot.kr_per_kg, 90);
  const unsold = endedLot({ id: 8, shortDescription: "Lego", isEnded: true, hasBids: false, buyItNowPrice: 300, longDescription: "Väger 2 kg" });
  assert.equal(unsold.sold, false);
  assert.equal(unsold.kg, 2);
});

test("Sammanfattning: avslutade, med bud, median kr/kg", () => {
  const s = summarizeLots({
    totalNumberOfItems: 3,
    items: [
      { shortDescription: "Lego 2 kg", isEnded: true, hasBids: true, maxBid: 200 },
      { shortDescription: "Lego 4 kg", isEnded: true, hasBids: true, maxBid: 480 },
      { shortDescription: "Lego låda", isEnded: false, buyItNowPrice: 500 },
    ],
  });
  assert.deepEqual([s.count, s.ended, s.sold, s.with_kg, s.priced], [3, 2, 2, 2, 2]);
  assert.equal(s.median_kr_per_kg, 110);
});

test("Testsökning: provar varianter och väljer den med flest avslutade", async () => {
  const original = globalThis.fetch;
  process.env.TRADERA_APP_ID ??= "1";
  process.env.TRADERA_APP_KEY ??= "k";
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if (body.request) return new Response("Bad request", { status: 400 });
    const ended = body.itemStatus === "Ended" && body.searchWords;
    const items = [{ id: 1, shortDescription: "Lego 3 kg", isEnded: Boolean(ended), hasBids: Boolean(ended), maxBid: 300 }];
    return new Response(JSON.stringify({ totalNumberOfItems: 1, items }), { status: 200 });
  };
  try {
    const r = await probeEndedSearch("lego kg");
    assert.equal(bodies.length, 4);
    assert.equal(r.best, "searchWords + itemStatus");
    assert.equal(r.sample.length, 1);
    assert.equal(r.sample[0].kr_per_kg, 100);
    assert.ok(r.variants.find((v) => v.name === "request-omslag").error);
  } finally {
    globalThis.fetch = original;
  }
});
