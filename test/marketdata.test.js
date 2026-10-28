import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSeller, discoverSellers, marketRow } from "../lib/marketdata.js";

const hit = (id, sellerId, o = {}) => ({ id, sellerId, sellerAlias: `s${sellerId}`, shortDescription: "Schleich häst 13279", hasBids: false, sellerDsrAverage: 4.9, ...o });

test("Hitta konkurrenter: grupperar aktiva och avslutade per säljare, minst N annonser", async () => {
  const bodies = [];
  const search = async (body) => {
    bodies.push(body);
    const ended = body.itemStatus === "Ended";
    if (body.pageNumber === 1) {
      return {
        totalNumberOfPages: ended ? 1 : 2,
        items: ended ? [hit(10, 1, { hasBids: true }), hit(11, 2), hit(1, 1)] : [hit(1, 1), hit(2, 1, { shortDescription: "Schleich häst" }), hit(3, 2)],
      };
    }
    return { items: [hit(4, 1), hit(5, 3)] };
  };
  const r = await discoverSellers({ search, minListings: 2 });
  assert.equal(bodies.length, 3);
  assert.equal(r.scanned, 7); // id 1 finns i båda listorna
  assert.deepEqual(r.sellers.map((s) => s.alias), ["s1", "s2"]);
  const s1 = r.sellers[0];
  assert.deepEqual([s1.total, s1.active, s1.ended, s1.with_bids, s1.number_share, s1.rating], [4, 3, 1, 1, 75, 4.9]);
});

test("Marknadsrad: status såld/osåld/aktiv", () => {
  const seller = { alias: "Daisy93", user_id: 42 };
  const base = { id: 7, title: "Schleich Tinker", number: "13279", number_source: "text", type: "köp nu", price: 70, bids: 0, shipping: 49, condition: "", start: "", end: "", days: 3, restarts: 0, url: "u", text: "t" };
  assert.equal(marketRow({ ...base, sold: true, ended: true }, seller).status, "Såld");
  assert.equal(marketRow({ ...base, sold: false, ended: true }, seller).status, "Osåld");
  const active = marketRow({ ...base, sold: false, ended: false }, seller);
  assert.deepEqual([active.status, active.id, active.seller_id, active.seller], ["Aktiv", "7", "42", "Daisy93"]);
});

test("Insamling: kända annonser hoppas över vid texthämtning, raderna skrivs till Sheet", async () => {
  const calls = [];
  const store = async (action, payload) => {
    calls.push({ action, payload });
    return action === "marketKnown" ? { ok: true, ids: ["1", "2"] } : { ok: true, added: 1, updated: 2 };
  };
  let skip;
  const fetchItems = async (alias, opts) => {
    skip = opts.skipDetail;
    return { alias: "Daisy93", user_id: 42, detail: { fetched: 1, errors: 0 }, items: [1, 2, 3].map((id) => ({ id, title: "x", number: "", sold: false, ended: false })) };
  };
  const r = await collectSeller({ alias: "Daisy93", user_id: 42 }, { store, fetchItems });
  assert.deepEqual([...skip], ["1", "2"]);
  assert.equal(calls[1].action, "marketUpsert");
  assert.equal(calls[1].payload.rows.length, 3);
  assert.deepEqual([r.items, r.added, r.updated], [3, 1, 2]);
  await assert.rejects(collectSeller({ alias: "x", user_id: 1 }, { store: async () => ({ ok: false, error: "Okänd action" }), fetchItems }), /Okänd action/);
});
