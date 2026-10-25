import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lensListings, lensRetail, lensSearch, lensText, platformFor, summarizeLens, toSek } from "../lib/lens.js";
import { mergeSettings } from "../lib/settings.js";

const fx = mergeSettings({}).fx;

test("valutor från Lens räknas om till SEK, okända hoppas över", () => {
  assert.equal(toSek({ extracted_value: 79, currency: "kr" }, fx), 79);
  assert.equal(toSek({ extracted_value: 6.5, currency: "€" }, fx), Math.round(6.5 * fx.EUR));
  assert.equal(toSek({ extracted_value: 10, currency: "$" }, fx), Math.round(10 * fx.USD));
  assert.equal(toSek({ extracted_value: 100, currency: "NOK" }, fx), 0);
  assert.equal(toSek(undefined, fx), 0);
});

test("pris utan valutafält: valutan läses ur texten (så som Lens svarar)", () => {
  assert.equal(toSek({ value: "119 kr*", extracted_value: 119 }, fx), 119);
  assert.equal(toSek({ value: "$12.99*", extracted_value: 12.99 }, fx), Math.round(12.99 * fx.USD));
  assert.equal(toSek({ value: "US$5", extracted_value: 5 }, fx), Math.round(5 * fx.USD));
  assert.equal(toSek({ value: "6,50 €", extracted_value: 6.5 }, fx), Math.round(6.5 * fx.EUR));
  assert.equal(toSek({ value: "£4.32", extracted_value: 4.32 }, fx), Math.round(4.32 * fx.GBP));
  assert.equal(toSek({ value: "120", extracted_value: 120 }, fx), 0);
});

test("riktigt Lens-svar (13910): butikspriser blir nypris, inte begagnade annonser", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/lens-13910.json", import.meta.url)));
  const s = summarizeLens(raw, fx);
  assert.equal(s.numbers[0].number, "13910");
  assert.equal(s.priced.length, 6);
  assert.deepEqual(lensListings(s), []);
  const retail = lensRetail(s);
  assert.deepEqual([retail.low, retail.high, retail.count], [81, 150, 6]);
});

test("plattform från länken", () => {
  assert.equal(platformFor("https://www.tradera.com/item/1"), "Tradera");
  assert.equal(platformFor("https://www.ebay.de/itm/1"), "eBay");
  assert.equal(platformFor("https://www.lekia.se/x"), "Butik");
  assert.equal(platformFor("inte en länk"), "Butik");
});

test("sammanfattning: dubbletter bort, nummer ur titlarna, bara prissatta blir annonser", () => {
  const s = summarizeLens(
    {
      exact_matches: [{ title: "Schleich 13695 Pinto", link: "https://www.ebay.de/itm/1", price: { value: "6,50 €", extracted_value: 6.5, currency: "€" } }],
      visual_matches: [
        { title: "Schleich 13695 Pinto", link: "https://www.ebay.de/itm/1" },
        { title: "Schleich 13695 ettåring", link: "https://www.tradera.com/item/2", price: { value: "79 kr", extracted_value: 79, currency: "kr" } },
        { title: "Schleich häst", link: "https://www.example.com/3" },
      ],
    },
    fx,
  );
  assert.equal(s.matches.length, 3);
  assert.deepEqual(s.numbers[0], { number: "13695", pages: 2 });
  assert.equal(s.priced.length, 2);
  const listings = lensListings(s);
  assert.deepEqual(listings.map((l) => [l.platform, l.price_sek, l.sold]), [["eBay", Math.round(6.5 * fx.EUR), false], ["Tradera", 79, false]]);
  assert.equal(lensRetail(s), null);
  assert.match(lensText(s), /13695 \(2 träffar\)/);
});

test("lensSearch: laddar upp bilden till /image och söker med image_id, svenska och Sverige", async () => {
  process.env.SERPAPI_API_KEY = "nyckel";
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === "https://serpapi.com/image") return new Response(JSON.stringify({ image_id: "img123" }), { status: 200 });
    return new Response(JSON.stringify({ visual_matches: [{ title: "Schleich 13695", link: "https://www.tradera.com/item/1", price: { extracted_value: 79, currency: "kr" } }] }), { status: 200 });
  };
  try {
    const r = await lensSearch({ mediaType: "image/jpeg", data: Buffer.from("jpegdata").toString("base64") }, fx);
    assert.equal(calls[0].init.method, "POST");
    assert.ok(calls[0].init.body instanceof FormData);
    assert.equal(calls[0].init.body.get("api_key"), "nyckel");
    assert.ok(calls[0].init.body.get("image") instanceof Blob);
    const search = new URL(calls[1].url);
    assert.equal(search.searchParams.get("engine"), "google_lens");
    assert.equal(search.searchParams.get("image_id"), "img123");
    assert.equal(search.searchParams.get("hl"), "sv");
    assert.equal(search.searchParams.get("country"), "se");
    assert.equal(r.summary.priced[0].price_sek, 79);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("för stor bild ger tydligt fel före uppladdning", async () => {
  await assert.rejects(
    lensSearch({ mediaType: "image/jpeg", data: Buffer.alloc(600 * 1024).toString("base64") }, fx),
    /max 500 kB/,
  );
});

test("utan krediter i SerpApi ger Lens ett tydligt fel (bildsöket tar då över i appen)", async () => {
  process.env.SERPAPI_API_KEY = "nyckel";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Your account has run out of searches." }), { status: 429 });
  try {
    await assert.rejects(lensSearch({ mediaType: "image/jpeg", data: "AAAA" }, fx), /run out of searches/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
