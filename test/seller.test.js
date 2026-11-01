import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSeller, modelNumber, numberFromText, sellerReport, toSellerItem } from "../lib/seller.js";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const raw = (o) => ({ id: 1, shortDescription: "Schleich Tinker sto 13279 (2003-08)", itemType: 3, buyItNowPrice: 89, startDate: ago(20), endDate: ago(15), startQuantity: 1, remainingQuantity: 0, totalBids: 0, status: { ended: true, gotBidders: false, gotWinner: true }, ...o });

test("Modellnummer ur rubriken, inte årtal", () => {
  assert.equal(modelNumber("Schleich Tinker sto 13279 (2003-08)"), "13279");
  assert.equal(modelNumber("Schleich häst 2008 13617"), "13617");
  assert.equal(modelNumber("Schleich hästar paket"), "");
});

test("Såld: gotWinner gäller både Köp nu och auktion; utan status används bud/antal", () => {
  const fixed = toSellerItem(raw({}), NOW);
  assert.deepEqual([fixed.sold, fixed.type, fixed.price, fixed.days, fixed.number], [true, "köp nu", 89, 5, "13279"]);
  const expired = toSellerItem(raw({ status: { ended: true, gotWinner: false }, remainingQuantity: 1 }), NOW);
  assert.equal(expired.sold, false);
  const auction = toSellerItem(raw({ itemType: 1, totalBids: 6, maxBid: 140, buyItNowPrice: 0, status: { ended: true, gotWinner: true } }), NOW);
  assert.deepEqual([auction.sold, auction.price], [true, 140]);
  const noStatus = toSellerItem(raw({ status: undefined, remainingQuantity: 0 }), NOW);
  assert.deepEqual([noStatus.sold, noStatus.has_status], [true, false]);
  const active = toSellerItem(raw({ endDate: ago(-10), status: { ended: false, gotWinner: false }, remainingQuantity: 1 }), NOW);
  assert.deepEqual([active.ended, active.sold, active.days], [false, false, 20]);
});

test("Rapport: säljgrad, median, dagar och modeller sorterade på flest sålda", () => {
  const items = [
    raw({ id: 1 }),
    raw({ id: 2, buyItNowPrice: 99, startDate: ago(30), endDate: ago(20) }),
    raw({ id: 3, status: { ended: true, gotWinner: false }, remainingQuantity: 1 }),
    raw({ id: 4, shortDescription: "Schleich Haflinger föl 13814", buyItNowPrice: 49 }),
    raw({ id: 5, shortDescription: "Schleich Haflinger föl 13814", buyItNowPrice: 59, endDate: ago(-5), status: { ended: false, gotWinner: false }, remainingQuantity: 1 }),
    raw({ id: 6, shortDescription: "Schleich djur paket", buyItNowPrice: 300 }),
  ].map((r) => toSellerItem(r, NOW));
  const r = sellerReport(items, NOW);
  assert.deepEqual([r.total, r.active, r.ended, r.sold, r.sell_through], [6, 1, 5, 4, 80]);
  assert.equal(r.with_number, 5);
  const tinker = r.models[0];
  assert.deepEqual([tinker.number, tinker.sold, tinker.ended, tinker.sell_through, tinker.median_sold, tinker.low, tinker.high], ["13279", 2, 3, 67, 94, 89, 99]);
  const foal = r.models.find((m) => m.number === "13814");
  assert.deepEqual([foal.sold, foal.active, foal.active_price], [1, 1, 59]);
  assert.deepEqual(r.prices[0], { price: 89, count: 2 }); // vanligaste Köp nu-priset
});

test("Hämtning: alias → id, aktiva + avslutade senaste året, utan dubbletter", async () => {
  const paths = [];
  const get = async (path) => {
    paths.push(path);
    if (path.startsWith("/v4/users/by-alias/")) return { id: 42, alias: "figurbutiken" };
    if (path.includes("filterActive=1")) return [raw({ id: 9, endDate: ago(-3), status: { ended: false, gotWinner: false } })];
    return [raw({ id: 1 }), raw({ id: 9 })];
  };
  const r = await fetchSeller("@figurbutiken", { get, now: NOW });
  assert.equal(paths[0], "/v4/users/by-alias/figurbutiken");
  assert.ok(paths.some((p) => p.startsWith("/v4/items/seller/42?") && p.includes("filterActive=2") && p.includes("minEndDate=")));
  assert.deepEqual([r.user_id, r.total, r.active], [42, 2, 1]);
  await assert.rejects(fetchSeller("  ", { get }), /Ange säljarens alias/);
  await assert.rejects(fetchSeller("okand", { get: async () => { throw new Error("Tradera 404: Not found"); } }), /Hittade ingen säljare/);
});

test("Nummer ur annonstexten: ensamt nummer, annars det intill Schleich/art.nr", () => {
  assert.deepEqual(numberFromText("<p>Schleich Tinker sto, art.nr 13279. Tillverkad 2003-2008.</p>"), { number: "13279", ambiguous: false });
  assert.deepEqual(numberFromText("Fin häst 13617 i lekt skick"), { number: "13617", ambiguous: false });
  assert.deepEqual(numberFromText("Schleich 13279. Passar ihop med 13280 som jag också säljer."), { number: "13279", ambiguous: false });
  assert.deepEqual(numberFromText("Två hästar: 13279 och 13280"), { number: "", ambiguous: true });
  assert.deepEqual(numberFromText("Ingen siffra här, frakt 49 kr"), { number: "", ambiguous: false });
  assert.deepEqual(numberFromText(undefined), { number: "", ambiguous: false });
});

test("Rubrik utan nummer: numret läses ur texten, och hämtas om texten saknas i listan", async () => {
  const fromText = toSellerItem(raw({ shortDescription: "Schleich Tinker sto", longDescription: "Schleich 13279 i lekt skick" }), NOW);
  assert.deepEqual([fromText.number, fromText.number_source], ["13279", "text"]);
  const get = async (path) => {
    if (path.startsWith("/v4/users/")) return { id: 7 };
    if (path.startsWith("/v4/items/seller/")) return path.includes("filterActive=2") ? [raw({ id: 5, shortDescription: "Schleich häst", longDescription: undefined }), raw({ id: 6, shortDescription: "Schleich föl", longDescription: "" })] : [];
    if (path === "/v4/items/6") return { id: 6, longDescription: "<p>Art.nr 13814</p>" };
    if (path === "/v4/items/5") return { id: 5, longDescription: "Modell 13617" };
    throw new Error(path);
  };
  const r = await fetchSeller("x", { get, now: NOW });
  assert.deepEqual(r.models.map((m) => m.number).sort(), ["13617", "13814"]); // tom text hämtas också
  assert.equal(r.number_from_text, 2);
  assert.deepEqual(r.detail, { fetched: 2, errors: 0 });
});

test("Bara Schleich: annonser utan Schleich i rubrik eller text hoppas över (och hämtas inte)", async () => {
  const fetched = [];
  const get = async (path) => {
    if (path.startsWith("/v4/items/seller/")) {
      return path.includes("filterActive=2")
        ? [raw({ id: 1 }), raw({ id: 2, shortDescription: "Lego Star Wars 75192" }), raw({ id: 3, shortDescription: "Häst sto", longDescription: "Schleich 13279" }), raw({ id: 4, shortDescription: "Barbie docka" })]
        : [];
    }
    fetched.push(path);
    return {};
  };
  const { fetchSellerItems, SCHLEICH } = await import("../lib/seller.js");
  const r = await fetchSellerItems("x", { get, userId: 9, only: SCHLEICH, now: NOW });
  assert.deepEqual(r.items.map((i) => i.id), [1, 3]);
  assert.deepEqual(fetched, []); // Barbie utan nummer hämtas inte en och en
});

test("pris för auktion utan bud = nästa bud (samma som Schleich-sökningen), med bud = högsta bud", async () => {
  const { toSellerItem } = await import("../lib/seller.js");
  assert.equal(toSellerItem({ id: 1, shortDescription: "x", itemType: 1, totalBids: 0, nextBid: 40, buyItNowPrice: 120, openingBid: 40 }).price, 40);
  assert.equal(toSellerItem({ id: 1, shortDescription: "x", itemType: 1, totalBids: 3, maxBid: 85, nextBid: 90, buyItNowPrice: 120 }).price, 85);
  assert.equal(toSellerItem({ id: 1, shortDescription: "x", itemType: 3, buyItNowPrice: 99 }).price, 99);
});
