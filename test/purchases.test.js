import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupPurchase, purchaseFromItem, traderaItemId } from "../lib/purchases.js";

test("Annons-id ur Tradera-länkar och rena nummer", () => {
  assert.equal(traderaItemId("https://www.tradera.com/item/1000532/701234567/42-st-schleich-djur"), "701234567");
  assert.equal(traderaItemId("https://www.tradera.com/item/701234567"), "701234567");
  assert.equal(traderaItemId(" 701234567 "), "701234567");
  assert.equal(traderaItemId("https://www.blocket.se/annons/123"), null);
});

test("Inköp från Tradera-annonsen: vunnen auktion (bud), billigaste frakten, köparskydd, antal ur rubriken", () => {
  const p = purchaseFromItem({
    id: 701234567, shortDescription: "42 st Schleich-djur", itemType: "Auction", totalBids: 7, maxBid: 380, buyItNowPrice: 0,
    shippingOptions: [{ cost: 0 }, { cost: 99 }, { cost: 79 }], endDate: "2026-11-02T20:15:00+01:00", thumbnailLink: "https://img/1.jpg",
  });
  assert.deepEqual(
    [p.price, p.shipping, p.fees, p.total_cost, p.item_count, p.bought_at, p.tradera_id, p.thumbnail],
    [380, 79, 21, 480, 42, "2026-11-02", "701234567", "https://img/1.jpg"],
  ); // köparskydd 2 + 5 % av 380 = 21
  const buyNow = purchaseFromItem({ id: 1, shortDescription: "Schleich paket", itemType: "PureBuyItNow", buyItNowPrice: 250, shippingOptions: [] });
  assert.deepEqual([buyNow.price, buyNow.shipping, buyNow.fees, buyNow.total_cost, buyNow.item_count], [250, 0, 15, 265, null]);
});

test("Uppslag: fel länk ger ett begripligt fel; rätt länk hämtar annonsen", async () => {
  await assert.rejects(lookupPurchase("hej"), /Hittar inget annons-id/);
  const asked = [];
  const p = await lookupPurchase("https://www.tradera.com/item/701234567", { get: async (path) => (asked.push(path), { id: 701234567, shortDescription: "10 st Schleich", buyItNowPrice: 100 }) });
  assert.deepEqual([asked[0], p.url, p.item_count], ["/v4/items/701234567", "https://www.tradera.com/item/701234567", 10]);
});
