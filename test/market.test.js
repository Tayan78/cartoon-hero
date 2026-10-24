import { test } from "node:test";
import assert from "node:assert/strict";
import { dropUnverifiedArticle, formatArticle, marketUrls, pickArticle, searchTerms } from "../lib/market.js";

test("söker på märke + artikelnummer när det är belagt", () => {
  const t = searchTerms({ item: { brand: "Schleich (trolig)", model: "Pinto föl", article_number: "13802", article_number_source: "föremålet" }, search_terms: { tradera: "schleich föl" } });
  assert.deepEqual(t, { tradera: "Schleich 13802", ebay: "Schleich 13802" });
});

test("annars modellens sökord", () => {
  const t = searchTerms({ item: { brand: "Rörstrand", model: "Mon Amie" }, search_terms: { tradera: "mon amie kopp", ebay: "rorstrand mon amie cup" } });
  assert.deepEqual(t, { tradera: "mon amie kopp", ebay: "rorstrand mon amie cup" });
});

test("bygger adresser till sålda och aktiva objekt", () => {
  const urls = marketUrls({ tradera: "Schleich 13802", ebay: "Schleich 13802" });
  assert.equal(urls.length, 3);
  assert.match(urls[0].url, /tradera\.com\/search\?q=Schleich%2013802&itemStatus=Ended/);
  assert.match(urls[1].url, /ebay\.com\/sch\/i\.html\?_nkw=Schleich%2013802&LH_Sold=1&LH_Complete=1/);
});

test("nummer ur minnet används inte, nummer från bildsöket eller föremålet används", () => {
  const id = (src) => ({ item: { brand: "Schleich", model: "Pintoföl", article_number: "13691", article_number_source: src }, search_terms: { tradera: "Schleich 13691 föl", ebay: "Schleich 13691 foal" } });
  const guessed = id("");
  dropUnverifiedArticle(guessed, "Bildsök: Mustang");
  assert.equal(guessed.item.article_number, "");
  assert.deepEqual(searchTerms(guessed), { tradera: "Schleich föl", ebay: "Schleich foal" });

  const fromVision = id("bildsöket");
  dropUnverifiedArticle(fromVision, "Artikel-/modellnummer i träffarna: 13691 (2 sidor)");
  assert.deepEqual(searchTerms(fromVision, "13691").ebay, "Schleich 13691");

  assert.equal(searchTerms(id("föremålet")).tradera, "Schleich 13691");
});

test("bara eBay-sidan hämtas av modellen; alla visas som länkar", () => {
  const urls = marketUrls({ tradera: "a", ebay: "b" });
  assert.deepEqual(urls.filter((u) => u.fetch).map((u) => u.label), ["eBay – sålda objekt"]);
});

test("modellnummer till kortet och Sheet: belagt först, annars Gemini/bildsök som obekräftat", () => {
  const verified = pickArticle({ item: { article_number: "13695", article_number_source: "gemini" } });
  assert.deepEqual(verified, { number: "13695", source: "Gemini", verified: true });
  assert.equal(formatArticle(verified), "13695 (Gemini)");

  const fromGemini = pickArticle({ item: { article_number: "" }, gemini: { grounded: false, raw: { article_number: "13695" } } });
  assert.equal(formatArticle(fromGemini), "13695 (Gemini, obekräftat)");

  const fromVision = pickArticle({ item: {}, vision: { numbers: [{ number: "13802", pages: 3 }] } });
  assert.equal(formatArticle(fromVision), "13802 (bildsök)");

  assert.equal(pickArticle({ item: {} }), null);
  assert.equal(formatArticle(null), "");
});
