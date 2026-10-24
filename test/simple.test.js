import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeResult } from "../lib/economics.js";
import { mergeSettings } from "../lib/settings.js";
import { geminiScan, toPriceRaw, verifyArticle } from "../lib/simple.js";

const settings = mergeSettings({});
const listing = (platform, price_sek, host) => ({ title: "x", url: `https://www.${host}/a/${price_sek}`, platform, price: price_sek, currency: "SEK", price_sek });

test("standardläget är enkelt", () => {
  assert.equal(settings.mode, "simple");
  assert.equal(mergeSettings({ mode: "advanced" }).mode, "advanced");
  assert.equal(mergeSettings({ mode: "annat" }).mode, "simple");
});

test("artikelnummer: belagt via din info, bildsök eller Google-källa – annars obekräftat", () => {
  assert.deepEqual(verifyArticle({ article: "13695", note: "schleich 13695" }), { number: "13695", source: "din info", verified: true });
  assert.equal(verifyArticle({ article: "13695", visionHints: "Schleich 13695 Pinto" }).source, "bildsök");
  assert.equal(verifyArticle({ article: "13695", supported: ['"article_number": "13695"'] }).source, "Google");
  assert.deepEqual(verifyArticle({ article: "13803" }), { number: "13803", source: "Gemini", verified: false });
  assert.equal(verifyArticle({ article: "" }), null);
});

test("annonser: utpris = lägsta Tradera/eBay även om Blocket är billigare", () => {
  const raw = toPriceRaw({
    price_sek: { low: 45, median: 79, high: 150, confidence: "high" },
    listings: [listing("Tradera", 99, "tradera.com"), listing("eBay", 75, "ebay.de"), listing("Blocket", 45, "blocket.se"), { url: "inte-en-url", price_sek: 1 }],
    buy_score: 60,
  });
  assert.equal(raw.sources.length, 3);
  const r = finalizeResult(raw, { buyPrice: 0, settings, mode: "listings" });
  assert.equal(r.mode, "listings");
  assert.deepEqual(r.for_sale, { low: 45, high: 99, count: 3 });
  assert.equal(r.economics.list_price, 75);
  assert.equal(r.economics.list_basis, "lägsta Tradera/eBay");
  assert.equal(r.economics.bid_floor, 0);
  assert.equal(r.price_sek.confidence, "high");
  assert.ok(!r.flags.some((f) => f.includes("sålda")), "inga flaggor om sålda i annonsläget");
  assert.equal(r.buy_score, 60);
});

test("annonser utan Tradera/eBay: utpris = lägsta annons; inga annonser: uppskattning och låg poäng", () => {
  const onlyBlocket = finalizeResult(toPriceRaw({ price_sek: { median: 60 }, listings: [listing("Blocket", 50, "blocket.se")], buy_score: 50 }), { buyPrice: 0, settings, mode: "listings" });
  assert.equal(onlyBlocket.economics.list_price, 50);
  assert.equal(onlyBlocket.economics.list_basis, "lägsta till salu");

  const none = finalizeResult(toPriceRaw({ price_sek: { median: 60, confidence: "high" }, listings: [], buy_score: 80 }), { buyPrice: 0, settings, mode: "listings" });
  assert.equal(none.economics.list_basis, "uppskattat");
  assert.equal(none.price_sek.confidence, "low");
  assert.ok(none.buy_score <= 25);
  assert.match(none.flags.join(" "), /Inga annonser till salu/);
});

test("Gemini-anropet: temperatur 0, svensk sökning, och utan svensk inställning om den avvisas", async () => {
  process.env.GEMINI_API_KEY = "test";
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.toolConfig) return new Response(JSON.stringify({ error: { message: "retrievalConfig not supported" } }), { status: 400 });
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"item":{"name":"Häst","article_number":"13695"},"listings":[]}' }] }, groundingMetadata: { webSearchQueries: ["schleich häst"] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
      }),
      { status: 200 },
    );
  };
  try {
    const r = await geminiScan({ images: [{ mediaType: "image/jpeg", data: "AAAA" }], hints: "", note: "", buyPrice: 0, settings });
    assert.equal(bodies[0].generationConfig.temperature, 0);
    assert.equal(bodies[0].toolConfig.retrievalConfig.languageCode, "sv_SE");
    assert.equal(bodies[1].toolConfig, undefined);
    assert.match(bodies[1].contents[0].parts.at(-1).text, /Sverige/);
    assert.equal(r.grounded, true);
    assert.equal(r.attempts, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
