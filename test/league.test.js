import { test } from "node:test";
import assert from "node:assert/strict";
import { league, weekBounds } from "../worker/src/league.js";
import { upsertListings, upsertSellers } from "../worker/src/data.js";
import { fakeD1 } from "./helpers/fake-d1.js";

test("Veckan: måndag–söndag svensk tid, veckonummer, dag i veckan, sommartidsbytet", () => {
  const sun = weekBounds(Date.parse("2026-11-01T10:00:00Z"));
  assert.deepEqual([new Date(sun.start).toISOString(), new Date(sun.end).toISOString(), sun.week, sun.day], ["2026-10-25T23:00:00.000Z", "2026-11-01T23:00:00.000Z", 44, 7]);
  const mon = weekBounds(Date.parse("2026-11-01T23:30:00Z")); // måndag 00:30 svensk tid
  assert.deepEqual([mon.week, mon.day], [45, 1]);
  const dst = weekBounds(Date.parse("2026-10-24T12:00:00Z"));
  assert.deepEqual([new Date(dst.start).toISOString(), new Date(dst.end).toISOString()], ["2026-10-18T22:00:00.000Z", "2026-10-25T23:00:00.000Z"]);
  assert.equal(weekBounds(Date.parse("2026-11-04T10:00:00Z"), -1).week, 44);
});

test("Ligan: placering, förändring sedan i går, till nästa placering, förra veckan och din historik", async () => {
  const db = fakeD1();
  await upsertSellers(db, [{ id: "1", alias: "Siri" }, { id: "2", alias: "Jeyd" }, { id: "9", alias: "Joulupukkin" }]);
  await db.prepare("UPDATE sellers SET own = 1 WHERE id = '9'").run();
  const rows = [];
  let n = 0;
  const sell = (seller, alias, count, at, price = 50) => {
    for (let i = 0; i < count; i++) rows.push({ id: `x${n++}`, seller_id: seller, seller: alias, title: "Schleich häst", niche: "djur", source: "sök", status: "Såld", price, end_at: at });
  };
  // Vecka 45: mån 2/11 – sön 8/11. "Nu" = onsdag 4/11 kl 12.
  sell("1", "Siri", 5, "2026-11-02T10:00:00+01:00"); // måndag
  sell("2", "Jeyd", 3, "2026-11-02T11:00:00Z");
  sell("9", "Joulupukkin", 2, "2026-11-03T09:00:00Z"); // tisdag
  sell("2", "Jeyd", 3, "2026-11-04T08:00:00Z"); // i dag: Jeyd går om Siri
  sell("9", "Joulupukkin", 1, "2026-11-04T09:00:00Z");
  // Vecka 44: du vann.
  sell("9", "Joulupukkin", 6, "2026-10-28T10:00:00Z");
  sell("1", "Siri", 4, "2026-10-29T10:00:00Z");
  // Vecka 43: plats 2.
  sell("1", "Siri", 3, "2026-10-21T10:00:00Z");
  sell("9", "Joulupukkin", 1, "2026-10-21T10:00:00Z");
  await upsertListings(db, rows);
  const now = Date.parse("2026-11-04T11:00:00Z");

  const w = await league(db, { now });
  assert.deepEqual([w.week, w.day, w.final, w.market.sold], [45, 3, false, 14]);
  assert.deepEqual(w.top.map((t) => [t.rank, t.alias, t.sold, t.move]), [[1, "Jeyd", 6, 1], [2, "Siri", 5, -1], [3, "Joulupukkin", 3, 0]]);
  assert.deepEqual(w.mine.to_next, { alias: "Siri", rank: 2, needed: 3 });
  assert.equal(w.mine.rank, 3);
  assert.equal(w.mine.prev, 6); // samma tid förra veckan (mån–ons)
  assert.deepEqual(w.history.best, { week: 44, rank: 1 });
  assert.equal(w.history.top3_streak, 2);

  const last = await league(db, { now, week: -1 });
  assert.deepEqual([last.week, last.final, last.top.map((t) => [t.rank, t.alias])], [44, true, [[1, "Joulupukkin"], [2, "Siri"]]]);
  assert.equal(last.top[0].move, undefined);
});
