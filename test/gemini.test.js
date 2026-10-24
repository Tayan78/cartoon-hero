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
