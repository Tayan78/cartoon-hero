import { test } from "node:test";
import assert from "node:assert/strict";
import { filterScans } from "../public/history.js";

const rec = (id, color, saved, item, extra = {}) => ({
  id, ts: id, saved, note: extra.note ?? "",
  data: { result: { item, article: extra.article ?? null, decision: color ? { color } : undefined } },
});
const list = [
  rec(1, "green", true, { name: "Schleich Tinkersto", brand: "Schleich" }, { article: { number: "13279" } }),
  rec(2, "red", false, { name: "Rörstrand Mon Amie kopp", brand: "Rörstrand" }),
  rec(3, "none", false, { name: "Schleich Knabstrupper sto", article_number: "13910" }, { note: "från loppis i Hägersten" }),
  rec(4, "", false, { name: "Okänt" }),
];

test("historik: filter på färg, sparad i lager och sökning", () => {
  assert.deepEqual(filterScans(list).map((r) => r.id), [1, 2, 3, 4]);
  assert.deepEqual(filterScans(list, { color: "green" }).map((r) => r.id), [1]);
  // Utan beslut räknas som "utan inköpspris".
  assert.deepEqual(filterScans(list, { color: "none" }).map((r) => r.id), [3, 4]);
  assert.deepEqual(filterScans(list, { saved: "yes" }).map((r) => r.id), [1]);
  assert.deepEqual(filterScans(list, { saved: "no", color: "red" }).map((r) => r.id), [2]);
  assert.deepEqual(filterScans(list, { q: "13279" }).map((r) => r.id), [1]);
  assert.deepEqual(filterScans(list, { q: "13910" }).map((r) => r.id), [3]);
  assert.deepEqual(filterScans(list, { q: "schleich sto" }).map((r) => r.id), [1, 3]);
  assert.deepEqual(filterScans(list, { q: "hägersten" }).map((r) => r.id), [3]);
  assert.deepEqual(filterScans(list, { q: "MON amie" }).map((r) => r.id), [2]);
});
