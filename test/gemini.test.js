import { test } from "node:test";
import assert from "node:assert/strict";
import { geminiArticle, geminiText } from "../lib/gemini.js";
import { dropUnverifiedArticle, searchTerms } from "../lib/market.js";

const result = (grounded) => ({
  raw: { name: "Schleich Pinto föl", article_number: "13695", confidence: "high", candidates: [] },
  queries: grounded ? ["schleich pinto foal"] : [],
  sources: [],
  grounded,
});

test("Geminis nummer räknas bara om Gemini faktiskt sökte", () => {
  assert.equal(geminiArticle(result(true)), "13695");
  assert.equal(geminiArticle(result(false)), "");
  assert.match(geminiText(result(false)), /sökte inte/);
});

test("Geminis sökta nummer används i prissökningen", () => {
  const id = { item: { brand: "Schleich", article_number: "13695", article_number_source: "gemini" }, search_terms: { tradera: "Schleich 13695", ebay: "Schleich 13695" } };
  const evidence = geminiArticle(result(true));
  dropUnverifiedArticle(id, evidence);
  assert.equal(searchTerms(id, evidence).ebay, "Schleich 13695");
});

test("provar reservmodell när huvudmodellen saknar kvot", async () => {
  process.env.GEMINI_API_KEY = "test";
  const { geminiIdentify } = await import("../lib/gemini.js");
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const model = url.match(/models\/([^:]+):/)[1];
    calls.push(model);
    if (model === "gemini-3.8-flash") {
      return new Response(JSON.stringify({ error: { message: "You exceeded your current quota. More text." } }), { status: 429 });
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"name":"Schleich Pinto föl","article_number":"13695"}' }] }, groundingMetadata: { webSearchQueries: ["schleich pinto"] } }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
      }),
      { status: 200 },
    );
  };
  try {
    const r = await geminiIdentify([{ mediaType: "image/jpeg", data: "AAAA" }]);
    assert.deepEqual(calls, ["gemini-3.8-flash", "gemini-3.5-flash"]);
    assert.equal(r.model, "gemini-3.5-flash");
    assert.equal(geminiArticle(r), "13695");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("felmeddelandet listar alla modeller när ingen har kvot", async () => {
  const { geminiIdentify } = await import("../lib/gemini.js");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "You exceeded your current quota. x" } }), { status: 429 });
  try {
    await assert.rejects(geminiIdentify([{ mediaType: "image/jpeg", data: "AAAA" }]), /gemini-3\.8-flash: You exceeded your current quota\. \| gemini-3\.5-flash: .* \| gemini-2\.5-flash/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("frågar igen med uttrycklig sökning när Gemini svarade utan att söka", async () => {
  const { geminiIdentify } = await import("../lib/gemini.js");
  const prompts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    prompts.push(body.contents[0].parts.at(-1).text);
    const grounded = prompts.length === 2;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: JSON.stringify({ name: "Schleich Pinto föl", brand: "Schleich", article_number: grounded ? "13695" : "13803" }) }] },
            groundingMetadata: grounded ? { webSearchQueries: ["Schleich Pinto föl 13803"] } : {},
          },
        ],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
      }),
      { status: 200 },
    );
  };
  try {
    const r = await geminiIdentify([{ mediaType: "image/jpeg", data: "AAAA" }]);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Du svarade utan att söka/);
    assert.equal(r.attempts, 2);
    assert.equal(geminiArticle(r), "13695");
    assert.equal(r.tokensIn, 2000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("prissökning med Gemini: Google-sökning, bara Tradera/eBay-källor", async () => {
  const { geminiPriceSearch } = await import("../lib/gemini.js");
  const { mergeSettings } = await import("../lib/settings.js");
  const settings = mergeSettings({ models: { search: "gemini" } });
  assert.equal(settings.models.search, "gemini");
  let body;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({
                price_sek: { median: 70, comparables: 2 },
                sources: [
                  { url: "https://www.tradera.com/item/1/2/hast", price_sek: 70, sold: true },
                  { url: "https://www.ebay.de/itm/9", price_sek: 79, sold: false },
                  { url: "https://example.com/fake", price_sek: 999, sold: true },
                ],
              }) }],
            },
            groundingMetadata: { webSearchQueries: ["site:tradera.com schleich 13695"] },
          },
        ],
        usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 400 },
      }),
      { status: 200 },
    );
  };
  try {
    const r = await geminiPriceSearch({ identification: { item: { name: "Schleich 13695" } }, vision: "", urls: [], buyPrice: 0, settings, note: "" });
    assert.deepEqual(body.tools, [{ google_search: {} }]);
    assert.match(body.contents[0].parts.at(-1).text, /Schleich 13695/);
    assert.equal(r.grounded, true);
    assert.deepEqual(r.raw.sources.map((s) => s.url), ["https://www.tradera.com/item/1/2/hast", "https://www.ebay.de/itm/9"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
