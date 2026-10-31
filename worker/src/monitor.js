// Översikten: körningar, anrop per dygn och siffror om databasen (D1).

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

// Lägger till anrop för dygnet: { tradera_search: 3, gemini: 1, … }.
export async function addUsage(db, counts, now = Date.now()) {
  const day = today(now);
  const rows = Object.entries(counts ?? {}).filter(([api, n]) => api && Number(n) > 0);
  if (!rows.length) return { added: 0 };
  await db.batch(
    rows.map(([api, n]) =>
      db.prepare("INSERT INTO usage (day, api, count) VALUES (?1, ?2, ?3) ON CONFLICT(day, api) DO UPDATE SET count = usage.count + excluded.count").bind(day, String(api).slice(0, 40), Math.round(Number(n))),
    ),
  );
  return { added: rows.length };
}

// En körning: utan id = start (ger id), med id = klar/fel.
export async function recordRun(db, { id, name, started_at, finished_at, status, summary }) {
  if (id) {
    await db.prepare("UPDATE runs SET finished_at = ?2, status = ?3, summary = ?4 WHERE id = ?1").bind(Number(id), finished_at ?? null, status ?? null, summary ?? null).run();
    return { id: Number(id) };
  }
  if (!name) throw new Error("name saknas");
  const row = await db
    .prepare("INSERT INTO runs (name, started_at, status, summary) VALUES (?1, ?2, ?3, ?4) RETURNING id")
    .bind(String(name), started_at ?? new Date().toISOString(), status ?? "Pågår", summary ?? null)
    .all();
  // Rensa: behåll de 50 senaste per typ.
  await db.prepare("DELETE FROM runs WHERE name = ?1 AND id NOT IN (SELECT id FROM runs WHERE name = ?1 ORDER BY started_at DESC LIMIT 50)").bind(String(name)).run();
  return { id: row.results[0]?.id };
}

const UNRESOLVED = `COALESCE(type, '') <> 'auktion' AND end_at IS NOT NULL AND end_at < ?1 AND (status IS NULL OR status = 'Aktiv')`;

export async function dashboard(db, { now = Date.now() } = {}) {
  const nowIso = new Date(now).toISOString();
  const since = today(now - 13 * 86400000);
  const growthSince = today(now - 59 * 86400000);
  const [totals, niches, series, sources, sellers, prices, unresolved, growth, soldByMonth, runs, usage] = await db.batch([
    db.prepare("SELECT COUNT(*) AS listings, SUM(status = 'Såld') AS sold, SUM(status = 'Osåld') AS unsold, SUM(status = 'Aktiv') AS active, MAX(last_seen) AS last_change FROM listings"),
    db.prepare("SELECT COALESCE(niche, '') AS key, COUNT(*) AS listings, SUM(status = 'Såld') AS sold FROM listings GROUP BY niche ORDER BY listings DESC"),
    db.prepare("SELECT COALESCE(series, '') AS key, COUNT(*) AS listings, SUM(status = 'Såld') AS sold FROM listings GROUP BY series ORDER BY listings DESC"),
    db.prepare("SELECT COALESCE(source, 'arket') AS key, COUNT(*) AS listings FROM listings GROUP BY source ORDER BY listings DESC"),
    db.prepare("SELECT COUNT(*) AS sellers, SUM(watched = 1) AS watched, (SELECT COUNT(DISTINCT seller_id) FROM listings) AS all_sellers FROM sellers"),
    db.prepare("SELECT COUNT(*) AS price_points FROM price_history"),
    db.prepare(`SELECT COUNT(*) AS n FROM listings WHERE ${UNRESOLVED}`).bind(nowIso),
    db.prepare("SELECT substr(first_seen, 1, 10) AS day, COUNT(*) AS n FROM listings WHERE first_seen >= ?1 GROUP BY day ORDER BY day").bind(growthSince),
    db.prepare("SELECT substr(end_at, 1, 7) AS month, COUNT(*) AS n FROM listings WHERE status = 'Såld' AND end_at IS NOT NULL GROUP BY month ORDER BY month"),
    db.prepare(
      "SELECT name, started_at, finished_at, status, summary FROM runs r WHERE (SELECT COUNT(*) FROM runs r2 WHERE r2.name = r.name AND r2.started_at > r.started_at) < 3 ORDER BY name, started_at DESC",
    ),
    db.prepare("SELECT day, api, count FROM usage WHERE day >= ?1 ORDER BY day").bind(since),
  ]);
  const t = totals.results[0] ?? {};
  const s = sellers.results[0] ?? {};
  const runsByName = {};
  for (const r of runs.results) (runsByName[r.name] ??= []).push(r);
  return {
    now: nowIso,
    db: {
      listings: t.listings ?? 0,
      sold: t.sold ?? 0,
      unsold: t.unsold ?? 0,
      active: t.active ?? 0,
      last_change: t.last_change ?? null,
      unresolved: unresolved.results[0]?.n ?? 0,
      price_points: prices.results[0]?.price_points ?? 0,
      sellers: s.sellers ?? 0,
      watched: s.watched ?? 0,
      all_sellers: s.all_sellers ?? 0,
      size_bytes: totals.meta?.size_after ?? null,
      niches: niches.results,
      series: series.results,
      sources: sources.results,
    },
    growth: growth.results,
    sold_by_month: soldByMonth.results,
    runs: runsByName,
    usage: usage.results,
  };
}

// ---------- Förslag på konkurrenter ----------
// Säljare i databasen rankade efter sålda Schleich-annonser (nisch, serie eller
// Schleich-sökningen), med säljgrad, medianpris och vad de mest säljer.
const SCHLEICH_ROW = "(l.niche IS NOT NULL OR l.series IS NOT NULL OR l.source = 'sök')";
const median = (xs) => {
  const s = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

export async function competitors(db, { limit = 40, min = 10, now = Date.now() } = {}) {
  const since = new Date(now - 90 * 86400000).toISOString();
  const { results: top } = await db
    .prepare(
      `SELECT l.seller_id AS id, MAX(l.seller) AS alias, COUNT(*) AS listings,
         SUM(l.status = 'Såld') AS sold, SUM(l.status = 'Osåld') AS unsold, SUM(l.status = 'Aktiv') AS active,
         SUM(l.status = 'Såld' AND l.end_at >= ?1) AS sold_90d, MAX(l.end_at) AS last_end,
         COALESCE(MAX(s.watched), 0) AS watched
       FROM listings l LEFT JOIN sellers s ON s.id = l.seller_id
       WHERE l.seller_id IS NOT NULL AND ${SCHLEICH_ROW}
       GROUP BY l.seller_id HAVING COUNT(*) >= ?2
       ORDER BY sold DESC, listings DESC LIMIT ?3`,
    )
    .bind(since, Math.max(1, Number(min) || 10), Math.min(Number(limit) || 40, 100))
    .all();
  if (!top.length) return { sellers: [] };
  const ids = top.map((t) => t.id);
  const { results: rows } = await db
    .prepare(`SELECT l.seller_id AS id, l.status, l.price, l.niche, l.series FROM listings l WHERE l.seller_id IN (${ids.map(() => "?").join(", ")}) AND ${SCHLEICH_ROW}`)
    .bind(...ids)
    .all();
  const by = new Map(ids.map((id) => [id, []]));
  for (const r of rows) by.get(r.id)?.push(r);
  return {
    sellers: top.map((t) => {
      const mine = by.get(t.id) ?? [];
      const mix = {};
      for (const r of mine) {
        const key = r.series ? r.series.split(",")[0] : r.niche || "övrigt";
        mix[key] = (mix[key] ?? 0) + 1;
      }
      const ended = (t.sold ?? 0) + (t.unsold ?? 0);
      return {
        ...t,
        watched: Boolean(t.watched),
        sell_through: ended ? Math.round((100 * t.sold) / ended) : null,
        median_sold: median(mine.filter((r) => r.status === "Såld").map((r) => r.price)),
        mix: Object.entries(mix).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key, n]) => ({ key, share: Math.round((100 * n) / mine.length) })),
      };
    }),
  };
}

// ---------- Produkter ----------
// Täckning (hur stor del av Schleich-annonserna som är kopplade till en produkt)
// och de mest sålda produkterna. Priser räknas bara på annonser med en enda
// produkt (ett paketpris säger inget om en enskild modell).
export async function productStats(db, { limit = 30 } = {}) {
  const [coverage, byMethod, top] = await db.batch([
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM listings WHERE niche IS NOT NULL OR series IS NOT NULL OR source = 'sök') AS schleich,
              (SELECT COUNT(DISTINCT listing_id) FROM listing_products) AS linked,
              (SELECT COUNT(*) FROM products) AS products,
              (SELECT COUNT(*) FROM listing_snapshots) AS snapshots,
              (SELECT COUNT(*) FROM categories) AS categories`,
    ),
    db.prepare("SELECT COALESCE(method, '') AS method, COUNT(*) AS n FROM listing_products GROUP BY method ORDER BY n DESC"),
    db
      .prepare(
        `SELECT lp.product_key AS key, COUNT(*) AS listings, SUM(l.status = 'Såld') AS sold, SUM(l.status = 'Aktiv') AS active
         FROM listing_products lp JOIN listings l ON l.id = lp.listing_id
         GROUP BY lp.product_key ORDER BY sold DESC, listings DESC LIMIT ?1`,
      )
      .bind(Math.min(Number(limit) || 30, 200)),
  ]);
  const keys = top.results.map((t) => t.key);
  let detail = [];
  if (keys.length) {
    detail = (
      await db
        .prepare(
          `SELECT lp.product_key AS key, l.title, l.status, l.price,
             (SELECT COUNT(*) FROM listing_products x WHERE x.listing_id = lp.listing_id) AS products_in_listing
           FROM listing_products lp JOIN listings l ON l.id = lp.listing_id WHERE lp.product_key IN (${keys.map(() => "?").join(", ")})`,
        )
        .bind(...keys)
        .all()
    ).results;
  }
  const by = new Map(keys.map((k) => [k, []]));
  for (const r of detail) by.get(r.key)?.push(r);
  const c = coverage.results[0] ?? {};
  return {
    coverage: { ...c, share: c.schleich ? Math.round((100 * c.linked) / c.schleich) : 0 },
    methods: byMethod.results,
    products: top.results.map((t) => {
      const rows = by.get(t.key) ?? [];
      const single = rows.filter((r) => r.products_in_listing === 1);
      const titles = {};
      for (const r of single) titles[r.title] = (titles[r.title] ?? 0) + 1;
      const ended = single.filter((r) => r.status === "Såld" || r.status === "Osåld").length;
      const soldPrices = single.filter((r) => r.status === "Såld").map((r) => r.price);
      return {
        ...t,
        name: Object.entries(titles).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        median_sold: median(soldPrices),
        sold_single: soldPrices.length,
        sell_through: ended ? Math.round((100 * soldPrices.length) / ended) : null,
      };
    }),
  };
}
