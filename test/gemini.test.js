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
