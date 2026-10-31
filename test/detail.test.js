import { test } from "node:test";
import assert from "node:assert/strict";
import { DETAIL_PER_STEP, detailRow, detailStep, fetchDetails } from "../lib/detail.js";
import { toSellerItem } from "../lib/seller.js";
import { sweepRow } from "../lib/sweep.js";

const NOW = Date.parse("2026-11-01T03:00:00Z");
const item = (o = {}) => ({
  id: 5, shortDescription: "Schleich häst brun", longDescription: "<p>Fin häst.</p><p>Art.nr 13729, gott skick.</p>",
  startDate: "2026-10-20T10:00:00+02:00", endDate: "2026-10-27T10:00:00+01:00", openingBid: 49, buyItNowPrice: 0,
  shippingOptions: [{ cost: 0 }, { cost: 59 }], imageLinks: ["a", "b", "c"], restarts: 1, reservePrice: 0,
  status: { ended: true, gotWinner: true }, maxBidder: { alias: "köparen" }, buyerList: [{ alias: "köparen" }], ...o,
});

test("Annonsdetalj → databasen: hela beskrivningen, startdatum, utropspris, frakt, bilder, verifierat utfall, modell ur texten", () => {
  const r = detailRow(5, item(), NOW);
  assert.equal(r.description, "<p>Fin häst.</p><p>Art.nr 13729, gott skick.</p>"); // som Tradera gav den
  assert.equal(r.text, "Fin häst. Art.nr 13729, gott skick.");
  assert.deepEqual(
    [r.start_at, r.opening_price, r.buy_now_price, r.shipping, r.image_count, r.restarts, r.reserve_met, r.status, r.sold_seen, r.detail_at],
    ["2026-10-20T10:00:00+02:00", 49, null, 59, 3, 1, null, "Såld", "2026-11-01T03:00:00.000Z", "2026-11-01T03:00:00.000Z"],
  );
  assert.deepEqual(r.products.map((p) => [p.key, p.method]), [["SCHLEICH-13729", "text"]]);
  assert.ok(!JSON.stringify(r).includes("köparen")); // köparens uppgifter sparas aldrig
  // Auktion med bud men reservpriset nåddes inte: inte såld.
  const reserve = detailRow(6, item({ reservePrice: 300, reservePriceReached: false, status: { ended: true, gotWinner: false } }), NOW);
  assert.deepEqual([reserve.reserve_met, reserve.status], [0, "Osåld"]);
  // Aktiv annons: ingen status ändras.
  assert.equal(detailRow(7, item({ endDate: "2026-12-01T10:00:00+01:00", status: { ended: false, gotWinner: false } }), NOW).status, undefined);
});

test("Rådatan från säljarna och sökningen innehåller aldrig köparnas uppgifter", () => {
  assert.ok(!toSellerItem({ id: 1, shortDescription: "Schleich häst", maxBidder: { alias: "köparen" }, buyerList: [1] }).raw.includes("köparen"));
  assert.ok(!sweepRow({ id: 1, shortDescription: "Schleich häst", maxBidder: "köparen" }, true, NOW).raw.includes("köparen"));
});

test("Ett steg: nyast först från databasen, borttagna annonser markeras som hämtade, fel räknas", async () => {
  const written = [];
  const get = async (path) => {
    if (path.endsWith("/2")) throw new Error("Tradera 404: Item not found");
    if (path.endsWith("/3")) throw new Error("Tradera 500: fel");
    return item({ id: Number(path.split("/").pop()) });
  };
  const out = await fetchDetails({ max: 3, get, need: async (n) => (assert.equal(n, 3), ["1", "2", "3"]), put: async (t, rows) => written.push(...rows), now: NOW });
  assert.deepEqual(out, { checked: 3, fetched: 1, missing: 1, errors: 1, linked: 1, more: true });
  assert.deepEqual(written.map((r) => [r.id, Boolean(r.description), r.detail_at]), [["1", true, "2026-11-01T03:00:00.000Z"], ["2", false, "2026-11-01T03:00:00.000Z"]]);
});

test("Nattens körning i steg: fortsätter tills det är slut eller nattens tak nås, sparas i körningshistoriken", async () => {
  const history = [];
  const hist = async (b) => (history.push(b), b.id ? b.id : 77);
  let calls = 0;
  const step = async ({ max }) => (calls++, { checked: max, fetched: max, linked: 10, errors: 0, more: true });
  let next = null;
  const s1 = await detailStep({}, { step, history: hist, next: async (st) => (next = st), perNight: 1000 });
  assert.deepEqual([s1.done, next?.done, s1.run_id], [DETAIL_PER_STEP, DETAIL_PER_STEP, 77]);
  next = null;
  const s2 = await detailStep(s1, { step, history: hist, next: async (st) => (next = st), perNight: 1000 });
  assert.equal(s2.done, 1000); // nattens tak
  assert.equal(next, null); // inget nästa steg
  assert.equal(calls, 2);
  assert.match(history.at(-1).summary, /1000 annonsdetaljer hämtade · 20 med modellnummer · fler kvar till nästa natt/);
});
