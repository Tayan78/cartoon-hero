import { test } from "node:test";
import assert from "node:assert/strict";
import { marketUrls, searchTerms } from "../lib/market.js";

test("söker på märke + artikelnummer när det finns", () => {
  const t = searchTerms({ item: { brand: "Schleich (trolig)", model: "Pinto föl", article_number: "13802" }, search_terms: { tradera: "schleich föl" } });
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
