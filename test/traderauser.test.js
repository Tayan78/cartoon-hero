import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchUserToken, saleRows, syncOwnOrders } from "../lib/traderauser.js";

const ORDER = {
  orderId: 501,
  createdDate: "2026-11-02T10:00:00Z",
  lastUpdatedDate: "2026-11-03T08:00:00Z",
  subTotal: 140,
  shippingCost: 59,
  shippingType: "PostNord",
  buyer: { alias: "köparen", firstName: "Anna", lastName: "A", email: "a@x.se" },
  shipTo: { name: "Anna A", addressLine1: "Gatan 1", zipCode: "12345", city: "Stad" },
  items: [
    { itemId: 7001, title: "Schleich Tinker sto 13773", quantity: 1, unitPrice: 80 },
    { itemId: 7002, title: "Schleich föl", quantity: 1, unitPrice: 60 },
  ],
  sellerOrderPayments: [{ paymentType: "Swish", amount: 199, paidDate: "2026-11-02T10:05:00Z" }],
};

test("ordrar → försäljningar: verkligt pris per objekt, köparens namn och adress följer aldrig med", () => {
  const rows = saleRows([ORDER]);
  assert.deepEqual(rows.map((r) => [r.order_id, r.item_id, r.unit_price, r.order_total, r.shipping_cost, r.paid_amount]), [
    [501, "7001", 80, 140, 59, 199],
    [501, "7002", 60, 140, 59, 199],
  ]);
  assert.equal(rows[0].paid_at, "2026-11-02T10:05:00Z");
  const flat = JSON.stringify(rows);
  for (const pii of ["Anna", "Gatan", "12345", "a@x.se", "köparen"]) assert.ok(!flat.includes(pii), pii);
  assert.deepEqual(saleRows(null), []);
});

test("nyckeln: hämtas med engångsnyckeln och ditt användar-id, ogiltig engångsnyckel stoppas", async () => {
  process.env.TRADERA_APP_ID = "1";
  process.env.TRADERA_APP_KEY = "k";
  const calls = [];
  const fetchImpl = async (url, init) => (calls.push([url, JSON.parse(init.body)]), new Response(JSON.stringify({ authToken: "T", hardExpirationTime: "2027-11-01T00:00:00Z" })));
  const skey = "a".repeat(40);
  assert.deepEqual(await fetchUserToken({ userId: "123", skey }, fetchImpl), { token: "T", expires: "2027-11-01T00:00:00Z" });
  assert.match(calls[0][0], /\/v4\/auth\/token$/);
  assert.deepEqual(calls[0][1], { userId: 123, secretKey: skey });
  await assert.rejects(() => fetchUserToken({ userId: "1", skey: "kort" }, fetchImpl), /engångsnyckel/);
});

test("nattlig hämtning: från förra hämtningen, med din nyckel, sparar raderna; okopplat konto hoppas över", async () => {
  process.env.APP_TOKEN = "x";
  process.env.TRADERA_APP_ID = "1";
  process.env.TRADERA_APP_KEY = "k";
  const now = Date.parse("2026-11-10T03:00:00Z");
  const saved = [];
  const own = async (b) => {
    if (b.op === "auth_get") return { auth: { user_id: "9", token: "T", expires: "2027-01-01T00:00:00Z" } };
    if (b.op === "status") return { sync: { synced_at: "2026-11-09T03:00:00Z" } };
    saved.push(b);
    return {};
  };
  const urls = [];
  const fetchImpl = async (url, init) => (urls.push([url, init.headers]), new Response(JSON.stringify([ORDER])));
  const r = await syncOwnOrders({ now, own, fetchImpl });
  assert.equal(r.fetched, 2);
  assert.equal(urls.length, 1, "ett fönster (förra hämtningen − 2 dygn)");
  assert.match(urls[0][0], /fromDate=2026-11-07T03%3A00%3A00\.000Z/);
  assert.equal(urls[0][1]["X-User-Token"], "T");
  assert.equal(urls[0][1]["X-User-Id"], "9");
  assert.equal(saved[0].rows.length, 2);
  assert.equal(saved.at(-1).synced_at, "2026-11-10T03:00:00.000Z");
  const none = await syncOwnOrders({ now, own: async () => ({ auth: null }), fetchImpl });
  assert.match(none.skipped, /inte kopplat/);
  const expired = await syncOwnOrders({ now, own: async () => ({ auth: { token: "T", user_id: "9", expires: "2026-01-01T00:00:00Z" } }), fetchImpl });
  assert.match(expired.skipped, /gått ut/);
  delete process.env.APP_TOKEN;
});
