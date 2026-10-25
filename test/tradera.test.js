import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeListings, parseSearch, toListing, traderaQuery, traderaSearch } from "../lib/tradera.js";

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
