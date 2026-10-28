import { test } from "node:test";
import assert from "node:assert/strict";
import { POST, allowed, pickFields } from "../api/analys.js";

test("Analys: bara läsanrop är tillåtna", () => {
  assert.ok(allowed("/v4/items/123"));
  assert.ok(allowed("/v4/items/seller/42?filterActive=2&minEndDate=2025-10-28T00:00:00.000Z"));
  assert.ok(allowed("/v4/users/by-alias/Daisy93"));
  assert.ok(allowed("/v4/search/advanced", true));
  assert.ok(!allowed("/v4/listings/items", true));
  assert.ok(!allowed("/v4/buyer/buy", true));
  assert.ok(!allowed("/v4/listings/seller-items"));
  assert.ok(!allowed("/v4/items/123/../../listings"));
  assert.ok(!allowed("/v4/search/advanced")); // POST-sökning kräver body
});

test("Analys: pick behåller bara valda fält", () => {
  assert.deepEqual(pickFields([{ id: 1, a: 2, b: 3 }], ["id", "b"]), [{ id: 1, b: 3 }]);
  assert.deepEqual(pickFields({ total: 1, items: [{ id: 1, a: 2 }] }, ["id"]), { total: 1, items: [{ id: 1 }] });
});

test("Analys: avstängd utan ANALYS_TOKEN, fel token ger 401", async () => {
  const req = (token) => new Request("http://x/api/analys", { method: "POST", headers: token ? { "x-analys-token": token } : {}, body: "{}" });
  delete process.env.ANALYS_TOKEN;
  assert.equal((await POST(req("x"))).status, 404);
  process.env.ANALYS_TOKEN = "hemligt";
  assert.equal((await POST(req("fel"))).status, 401);
  assert.equal((await POST(req())).status, 401);
  delete process.env.ANALYS_TOKEN;
});
