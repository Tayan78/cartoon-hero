import { test } from "node:test";
import assert from "node:assert/strict";
import { countFromImages, countLots, imagesOf, parseCount } from "../lib/lotcount.js";
import { findLots, singleStats } from "../lib/lots.js";
import { NICHES } from "../lib/niches.js";

test("Bilder: vanliga länkar först, inga miniatyrer eller dubbletter, högst fyra", () => {
  const item = {
    imageLinks: ["https://img/1.jpg", "https://img/2.jpg"],
    detailedImageLinks: [
      { url: "https://img/1.jpg", format: "Large" },
      { url: "https://img/3-thumb.jpg", format: "Thumbnail" },
      { url: "https://img/4.jpg", format: "Large" },
      { url: "https://img/5.jpg", format: "Large" },
      { url: "https://img/6.jpg", format: "Large" },
    ],
  };
  assert.deepEqual(imagesOf(item), ["https://img/1.jpg", "https://img/2.jpg", "https://img/4.jpg", "https://img/5.jpg"]);
  assert.deepEqual(imagesOf({}), []);
});

test("Modellens svar: intervall i rätt ordning, bästa gissning inom intervallet, orimligt = null", () => {
  assert.deepEqual(parseCount({ min: 18, max: 24, best: 20, confidence: "high", note: "ca 20 hästar" }), { min: 18, max: 24, best: 20, confidence: "high", note: "ca 20 hästar" });
  assert.deepEqual(parseCount({ min: 24, max: 18, best: 30, confidence: "medium" }), { min: 18, max: 24, best: 24, confidence: "medium", note: "" });
  assert.deepEqual(parseCount({ best: 12 }), { min: 12, max: 12, best: 12, confidence: "low", note: "" }); // okänd säkerhet = osäkert
  assert.equal(parseCount({ min: 1, max: 1 }), null); // en figur är inget parti
  assert.equal(parseCount({ min: 10, max: 900 }), null);
  assert.equal(parseCount({ name: "trasigt svar" }), null);
});

test("Räkning: bilderna skickas till modellen utan sökning; bilder som inte går att hämta hoppas över", async () => {
  const calls = [];
  const askModel = async (images, prompt, models, opts) => (calls.push({ images, opts }), { raw: { min: 15, max: 18, best: 16, confidence: "high" }, usd: 0.004 });
  const fetchImage = async (url) => (url.includes("bad") ? Promise.reject(new Error("404")) : { mediaType: "image/jpeg", data: url });
  const r = await countFromImages(["https://img/1.jpg", "https://img/bad.jpg"], { askModel, fetchImage });
  assert.deepEqual(r, { min: 15, max: 18, best: 16, confidence: "high", note: "", images: 1, usd: 0.004 });
  assert.deepEqual(calls[0].opts, { search: false, temperature: 0 });
  assert.equal(await countFromImages(["https://img/bad.jpg"], { askModel, fetchImage }), null);
});

const lot = (o) => ({ id: 1, title: "Schleich djur paket", ended: false, count: null, images: ["https://img/1.jpg"], ...o });

test("Partier utan antal räknas en gång: sparade räkningar återanvänds, högst N nya per hämtning", async () => {
  const sheet = [{ "Annons-ID": "2", Min: 10, Max: 12, "Bäst": 11, "Säkerhet": "medium", Anteckning: "sparad" }];
  const writes = [];
  const store = async (action, p) => (action === "sheetRead" ? { ok: true, rows: sheet } : (writes.push(p), { ok: true }));
  const counted = [];
  const count = async (images) => (counted.push(images), { min: 20, max: 25, best: 22, confidence: "high", note: "", images: 1, usd: 0.005 });
  const lots = [
    lot({ id: 1 }),
    lot({ id: 2 }), // redan räknad
    lot({ id: 3 }),
    lot({ id: 4, count: 30 }), // antal i rubriken
    lot({ id: 5, ended: true }), // avslutad
    lot({ id: 6, images: [] }), // inga bilder
  ];
  const r = await countLots(lots, { store, count, max: 1, now: Date.parse("2026-10-30T12:00:00Z") });
  assert.equal(counted.length, 1); // bara en ny räkning (max 1)
  assert.deepEqual([r.counted, r.pending, r.usd], [1, 1, 0.005]);
  const byId = Object.fromEntries(r.lots.map((l) => [l.id, l]));
  assert.deepEqual([byId[1].count, byId[1].count_estimate], [20, { min: 20, max: 25, best: 22, confidence: "high", note: "" }]);
  assert.equal(byId[2].count, 10); // lägsta antalet från arket
  assert.equal(byId[3].count, null); // väntar till nästa hämtning
  assert.equal(byId[4].count_estimate, undefined);
  assert.equal(writes[0].sheet, "Bildräkning");
  assert.deepEqual(writes[0].rows.map((w) => [w["Annons-ID"], w.Min, w.Max, w["Bäst"], w.Räknad]), [["1", 20, 25, 22, "2026-10-30T12:00:00.000Z"]]);
});

test("Fynd: parti utan antal värderas på lägsta bildräkningen – osäker räkning blir aldrig fynd", async () => {
  // 12 sålda hästar à 70–125 kr → netto 88 per figur.
  const rows = Array.from({ length: 12 }, (_, i) => ({ Rubrik: "Schleich Tinker sto", Status: "Såld", Pris: 70 + 5 * i, Nisch: "djur" }));
  const singles = singleStats(rows, NICHES.djur);
  assert.equal(singles.all.net, 88);
  const item = { id: 7, shortDescription: "Schleich hästar paket", itemType: "PureBuyItNow", buyItNowPrice: 300, bidCount: 0 };
  const search = async (body) => ({ totalNumberOfPages: 1, items: body.itemStatus ? [] : [item] });
  const get = async () => ({ shippingOptions: [{ cost: 59 }], imageLinks: ["https://img/7.jpg"] });
  const store = async (action, p) => (action === "sheetRead" && p.sheet === "Marknad" ? { ok: true, rows: p.filter.equals === "Såld" ? rows : [] } : { ok: true, rows: [] });
  const run = (confidence) => findLots({ niche: "djur", search, get, store, count: async () => ({ min: 12, max: 16, best: 14, confidence, note: "", images: 1, usd: 0 }) });

  const sure = await run("high");
  const [l] = sure.deals;
  // 12 × 88 = 1 056 netto; 300 + köparskydd 17 + frakt 59 = 376 → 2,8×.
  assert.deepEqual([l.count, l.value, l.total, l.deal], [12, 1056, 376, true]);
  assert.deepEqual(l.count_estimate, { min: 12, max: 16, best: 14, confidence: "high", note: "" });
  assert.equal(l.images, undefined); // bildadresserna skickas inte till appen
  assert.deepEqual([sure.image_counted, sure.without_count, sure.count_pending], [1, 0, 0]);

  const unsure = await run("low");
  assert.equal(unsure.deals[0].deal, false);
});
