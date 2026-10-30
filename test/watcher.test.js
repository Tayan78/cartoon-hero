import { test } from "node:test";
import assert from "node:assert/strict";
import { candidates, evaluate, notification, pageOrder, pickOrderBy, searchBody } from "../worker/src/watch.js";
import { singleStats } from "../lib/lots.js";
import { NICHES } from "../lib/niches.js";

const item = (o) => ({ id: 1, shortDescription: "Schleich paket 10 st hästar", itemType: "PureBuyItNow", buyItNowPrice: 200, bidCount: 0, itemUrl: "https://www.tradera.com/item/1", thumbnailLink: "https://img/1.jpg", ...o });
// 12 sålda hästar à 70–125 kr i Marknad → median 98, netto 88 efter 10 % avgift.
const rows = Array.from({ length: 12 }, (_, i) => ({ Rubrik: "Schleich Tinker sto", Status: "Såld", Pris: 70 + 5 * i, Nisch: "djur" }));
const singles = { djur: singleStats(rows, NICHES.djur) };

test("Kandidater: nya Köp nu-partier i bevakad nisch med antal – inte sedda, auktioner utan Köp nu eller annat", () => {
  const items = [
    item({ id: 1 }),
    item({ id: 2 }), // redan sedd
    item({ id: 3, itemType: "Auction", buyItNowPrice: 0, nextBid: 50 }), // auktion utan Köp nu
    item({ id: 4, itemType: "Auction", buyItNowPrice: 300, nextBid: 100 }), // auktion med Köp nu – går att köpa direkt
    item({ id: 5, shortDescription: "Schleich Tinker sto 13279" }), // ingen parti
    item({ id: 6, shortDescription: "Smurfar 20 st" }), // annan nisch
    item({ id: 7, shortDescription: "Schleich paket blandat" }), // inget antal
  ];
  const c = candidates(items, new Set(["2"]));
  assert.deepEqual(c.map((x) => x.lot.id), [1, 4]);
});

test("Värdering: grönt Köp nu-parti blir notis, för dyrt blir det inte", async () => {
  const getItem = async () => ({ shippingOptions: [{ cost: 59 }] });
  const cheap = candidates([item({ id: 1, buyItNowPrice: 200 })], new Set());
  const [deal] = await evaluate(cheap, { getItem, singles, rules: {} });
  // 10 × 88 = 880 netto, betala högst 440; 200 + köparskydd 12 + frakt 59 = 271.
  assert.deepEqual([deal.value, deal.pay_max, deal.total, deal.deal], [880, 440, 271, true]);
  const dear = candidates([item({ id: 2, buyItNowPrice: 500 })], new Set());
  assert.deepEqual(await evaluate(dear, { getItem, singles, rules: {} }), []);
  assert.deepEqual(await evaluate(cheap, { getItem, singles: null, rules: {} }), []); // utan marknadsdata: ingen notis
  const n = notification(deal, "loppis-abc");
  assert.equal(n.topic, "loppis-abc");
  assert.equal(n.click, "https://www.tradera.com/item/1");
  assert.equal(n.priority, 5);
  assert.match(n.title, /10 st – Köp nu 200 kr \(3,2×\)/);
  assert.match(n.message, /Totalt 271 kr inkl\. köparskydd och frakt · värt ca 880 kr/);
});

test("Auktion med Köp nu under gränsen: notisen visar Köp nu-priset", async () => {
  const c = candidates([item({ id: 4, itemType: "Auction", buyItNowPrice: 250, nextBid: 100 })], new Set());
  const [deal] = await evaluate(c, { getItem: async () => ({ shippingOptions: [{ cost: 59 }] }), singles, rules: {} });
  assert.equal(deal.buy_now_ok, true);
  assert.match(notification(deal, "t").title, /Köp nu 250 kr/);
});

const ids = (list) => list.map((id) => ({ id }));

test("Sortering: första som Tradera godtar OCH faktiskt sorterar efter (fallande id)", async () => {
  const tried = [];
  const desc = ids([90, 80, 70, 60, 50, 40]);
  const search = async (body) => (tried.push(body.orderBy), body.orderBy === "StartDateDescending" ? { errors: [{ code: "OrderByValidationError" }] } : { items: desc });
  assert.equal(await pickOrderBy(search), "EndDateDescending");
  assert.deepEqual(tried, ["StartDateDescending", "EndDateDescending"]);
  // Godtas men ignoreras (osorterat) → nästa som sorterar väljs.
  const ignored = async (body) => ({ items: body.orderBy === "StartDateDescending" ? ids([10, 90, 20, 80, 30, 70]) : desc });
  assert.equal(await pickOrderBy(ignored), "EndDateDescending");
  // Ingen sorterar: den första som godtogs används ändå.
  assert.equal(await pickOrderBy(async () => ({ items: ids([10, 90, 20, 80, 30, 70]) })), "StartDateDescending");
  assert.deepEqual(pageOrder(desc), { newest_id: 90, sorted_desc: true });
  assert.deepEqual(searchBody("EndDateDescending"), { categoryId: 1000532, itemsPerPage: 50, pageNumber: 1, orderBy: "EndDateDescending" });
});

test("Testannons: exempelpartiet ger en riktig träffnotis", async () => {
  const { EXAMPLE_DEAL, notification } = await import("../worker/src/watch.js");
  const n = notification(EXAMPLE_DEAL, "topic");
  assert.equal(n.title, "💎 24 st – Köp nu 349 kr (2,4×)");
  assert.match(n.message, /^TEST – 24 st Schleich/);
  assert.equal(n.priority, 5);
  assert.equal(n.click, EXAMPLE_DEAL.url);
});
