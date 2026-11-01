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

  const w = await league(db, { now, metric: "count" });
  assert.deepEqual([w.week, w.day, w.final, w.market.sold], [45, 3, false, 14]);
  assert.deepEqual(w.top.map((t) => [t.rank, t.alias, t.sold, t.move]), [[1, "Jeyd", 6, 1], [2, "Siri", 5, -1], [3, "Joulupukkin", 3, 0]]);
  assert.deepEqual(w.mine.to_next, { alias: "Siri", rank: 2, needed: 3, unit: "st" });
  assert.equal(w.mine.rank, 3);
  assert.equal(w.mine.prev, 6); // samma tid förra veckan (mån–ons)
  assert.deepEqual(w.history.best, { week: 44, rank: 1 });
  assert.equal(w.history.top3_streak, 2);

  const last = await league(db, { now, week: -1, metric: "count" });
  assert.deepEqual([last.week, last.final, last.top.map((t) => [t.rank, t.alias])], [44, true, [[1, "Joulupukkin"], [2, "Siri"]]]);
  assert.equal(last.top[0].move, undefined);
});

test("Månadsligan: denna och förra månaden, dag i månaden, samma tid förra månaden, bästa månad", async () => {
  const { monthBounds } = await import("../worker/src/league.js");
  const nov = monthBounds(Date.parse("2026-11-04T11:00:00Z"));
  assert.deepEqual([new Date(nov.start).toISOString(), new Date(nov.end).toISOString(), nov.label, nov.day, nov.days], ["2026-10-31T23:00:00.000Z", "2026-11-30T23:00:00.000Z", "november", 4, 30]);
  const oct = monthBounds(Date.parse("2026-11-04T11:00:00Z"), -1);
  assert.deepEqual([new Date(oct.start).toISOString(), oct.label, oct.days], ["2026-09-30T22:00:00.000Z", "oktober", 31]);

  const db = fakeD1();
  await upsertSellers(db, [{ id: "1", alias: "Siri" }, { id: "9", alias: "Joulupukkin" }]);
  await db.prepare("UPDATE sellers SET own = 1 WHERE id = '9'").run();
  const rows = [];
  let n = 0;
  const sell = (seller, alias, count, at) => {
    for (let i = 0; i < count; i++) rows.push({ id: `m${n++}`, seller_id: seller, seller: alias, title: "Schleich häst", niche: "djur", source: "sök", status: "Såld", price: 50, end_at: at });
  };
  sell("1", "Siri", 4, "2026-11-02T10:00:00Z");
  sell("9", "Joulupukkin", 2, "2026-11-03T10:00:00Z");
  sell("9", "Joulupukkin", 9, "2026-10-02T10:00:00Z"); // oktober: du vann, 9 st före den 4:e
  sell("1", "Siri", 5, "2026-10-20T10:00:00Z");
  await upsertListings(db, rows);
  const now = Date.parse("2026-11-04T11:00:00Z");
  const m = await league(db, { period: "month", now, metric: "count" });
  assert.deepEqual([m.period, m.label, m.day, m.days, m.mine.rank, m.mine.prev, m.market.prev], ["month", "november", 4, 30, 2, 9, 9]);
  assert.deepEqual(m.mine.to_next, { alias: "Siri", rank: 1, needed: 3, unit: "st" });
  assert.deepEqual(m.history.best, { month: 10, label: "oktober", rank: 1 });
  const last = await league(db, { period: "month", offset: -1, now });
  assert.deepEqual([last.label, last.final, last.top.map((t) => [t.rank, t.alias, t.sold])], ["oktober", true, [[1, "Joulupukkin", 9], [2, "Siri", 5]]]);
});

test("Omsättning som standard: färre men dyrare försäljningar slår många billiga", async () => {
  const db = fakeD1();
  await upsertSellers(db, [{ id: "1", alias: "jeyd" }, { id: "9", alias: "Joulupukkin" }]);
  await db.prepare("UPDATE sellers SET own = 1 WHERE id = '9'").run();
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ id: `j${i}`, seller_id: "1", seller: "jeyd", title: "Smurf Schleich", niche: "smurfar", source: "sök", status: "Såld", price: 27, end_at: "2026-11-03T10:00:00Z" });
  for (let i = 0; i < 18; i++) rows.push({ id: `m${i}`, seller_id: "9", seller: "Joulupukkin", title: "Schleich häst", niche: "djur", source: "sök", status: "Såld", price: 77, end_at: "2026-11-03T10:00:00Z" });
  await upsertListings(db, rows);
  const now = Date.parse("2026-11-04T11:00:00Z");
  const byRevenue = await league(db, { now });
  assert.deepEqual([byRevenue.metric, byRevenue.top.map((t) => [t.rank, t.alias, t.revenue])], ["revenue", [[1, "Joulupukkin", 1386], [2, "jeyd", 540]]]);
  const byCount = await league(db, { now, metric: "count" });
  assert.deepEqual(byCount.top.map((t) => t.alias), ["jeyd", "Joulupukkin"]);
  assert.deepEqual(byCount.mine.to_next, { alias: "jeyd", rank: 1, needed: 3, unit: "st" });
  const jeyd = await league(db, { now, history: 0 });
  assert.equal(jeyd.mine.rank, 1);
});
