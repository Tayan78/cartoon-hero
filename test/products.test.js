import { test } from "node:test";
import assert from "node:assert/strict";
import { productLinks } from "../lib/products.js";
import { flattenCategories, relinkProducts } from "../lib/productsync.js";
import { sweepRow } from "../lib/sweep.js";

test("Produktnyckel från modellnumret: rubrik före text, flera nummer = paket, bara i Schleich-annonser", () => {
  assert.deepEqual(productLinks({ title: "Schleich Hannoveraner sto 13729" }), [{ key: "SCHLEICH-13729", model_number: "13729", method: "rubrik", confidence: 0.95 }]);
  assert.deepEqual(
    productLinks({ title: "Schleich 13729 och 13649" }).map((p) => [p.key, p.confidence]),
    [["SCHLEICH-13729", 0.8], ["SCHLEICH-13649", 0.8]],
  );
  assert.deepEqual(productLinks({ title: "Schleich häst brun", text: "Fin häst, art.nr 13729." }), [{ key: "SCHLEICH-13729", model_number: "13729", method: "text", confidence: 0.8 }]);
  assert.deepEqual(productLinks({ title: "Schleich häst brun" }), []); // inget nummer – AI-steget senare
  assert.deepEqual(productLinks({ title: "Lego Star Wars 75313" }), []); // inte Schleich
  assert.deepEqual(productLinks({ title: "Schleich stall 12500 kr" }), []); // ett pris, inget modellnummer
  assert.deepEqual(productLinks({ title: "Schleich häst från 2015" }), []); // årtal
  assert.equal(productLinks({ title: "Bayala älva 70582" })[0].key, "SCHLEICH-70582");
});

test("Schleich-sökningen sätter modellnummer och produkt på annonsen", () => {
  const row = sweepRow({ id: 1, shortDescription: "Schleich Tinker sto 13773", itemType: "PureBuyItNow", buyItNowPrice: 79 }, false, Date.parse("2026-11-01T03:00:00Z"));
  assert.deepEqual([row.model_number, row.number_source, row.products.map((p) => p.key)], ["13773", "rubrik", ["SCHLEICH-13773"]]);
});

test("Efterhandskoppling: sidor av annonser utan produkt, bara de med nummer skickas", async () => {
  const pages = [
    { rows: [{ id: "1", title: "Schleich 13729" }, { id: "2", title: "Schleich häst" }], next: "2" },
    { rows: [{ id: "3", title: "Schleich ko", text: "Modell 13797" }], next: "3" },
  ];
  const asked = [];
  const sent = [];
  const out = await relinkProducts({ texts: async (q) => (asked.push(q.after), pages.shift() ?? { rows: [], next: null }), put: async (t, rows) => sent.push([t, rows.map((r) => r.id)]), page: 2 });
  assert.deepEqual(out, { scanned: 3, linked: 2 });
  assert.deepEqual(asked, ["", "2"]);
  assert.deepEqual(sent, [["links", ["1"]], ["links", ["3"]]]);
});

test("Kategoriträdet blir platta rader med sökväg", () => {
  const tree = [{ id: 1, name: "Leksaker", childCategories: [{ id: 2, name: "Figurer", children: [{ id: 1000532, name: "Miniatyrer & leksaksfigurer" }] }] }, { Id: 3, Name: "Böcker", Category: [{ Id: 4, Name: "Barn" }] }];
  assert.deepEqual(flattenCategories(tree), [
    { id: 1, name: "Leksaker", parent_id: null, path: "Leksaker" },
    { id: 2, name: "Figurer", parent_id: 1, path: "Leksaker > Figurer" },
    { id: 1000532, name: "Miniatyrer & leksaksfigurer", parent_id: 2, path: "Leksaker > Figurer > Miniatyrer & leksaksfigurer" },
    { id: 3, name: "Böcker", parent_id: null, path: "Böcker" },
    { id: 4, name: "Barn", parent_id: 3, path: "Böcker > Barn" },
  ]);
});
