// Minimal D1 över node:sqlite (samma motor som D1), med alla migreringar i ordning.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DIR = new URL("../../worker/migrations/", import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

// Minimal D1: prepare().bind().all()/run() och batch() i en transaktion.
export function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) sqlite.exec(readFileSync(new URL(f, DIR), "utf8"));
  const prepare = (sql) => {
    let params = [];
    const s = {
      bind: (...p) => ((params = p), s),
      all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
      run: async () => (sqlite.prepare(sql).run(...params), { success: true }),
    };
    return s;
  };
  const batch = async (list) => {
    sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const st of list) out.push(await st.all());
      sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err;
    }
  };
  return { prepare, batch, sqlite };
}

// Insamlingens beroenden mot den riktiga worker-koden.
export async function dataApi(db) {
  const { recordRun } = await import("../../worker/src/monitor.js");
  const { sellerList, upsertListings, upsertSellers } = await import("../../worker/src/data.js");
  return {
    list: (o = {}) => sellerList(db, o).then((d) => d.sellers),
    put: (table, rows) => (table === "sellers" ? upsertSellers(db, rows) : upsertListings(db, rows)),
    latest: (name) => recordRun(db, { latest: name }).then((d) => d.run),
    run: (body) => recordRun(db, body).then((d) => d.id),
  };
}
