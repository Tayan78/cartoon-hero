// Marknadsanalys (BI) för Schleich: allt räknas i SQL i D1 (workerns gratisnivå
// har bara 10 ms processortid per anrop). Period = de senaste N dagarna räknat på
// slutdatum (days = null: allt). Avslutade annonser med slutdatum i framtiden
// (butiksannonser som löper i åratal) räknas inte.

const SCHLEICH = "(niche IS NOT NULL OR series IS NOT NULL OR source = 'sök')";
const DAY = "substr(end_at, 1, 10)";
const PERIOD = `${DAY} <= date('now') AND (?1 IS NULL OR ${DAY} > date('now', '-' || ?1 || ' days'))`;
const ENDED = `${SCHLEICH} AND status IN ('Såld', 'Osåld') AND end_at IS NOT NULL AND ${PERIOD}`;

// Segment i SQL (samma indelning som förhandsvisningen, förenklad): serier som
// inte är djur, smurfar, partier (ord som "st", "paket", "samling" …), hästar
// och övriga djur. lower() i SQLite hanterar bara a–z – å/ä/ö i versaler är sällsynt.
const T = "(' ' || lower(title) || ' ')";
const LOT = `(${T} GLOB '* [0-9]* st *' OR ${T} GLOB '* [0-9]*st *' OR ${T} LIKE '% paket%' OR ${T} LIKE '% samling%'
  OR ${T} LIKE '% parti %' OR ${T} LIKE '% blandat%' OR ${T} LIKE '% blandade%' OR ${T} LIKE '% lot %' OR ${T} LIKE '% mängd%')`;
const HORSE = `(${T} LIKE '%häst%' OR ${T} LIKE '%föl%' OR ${T} LIKE '%hingst%' OR ${T} LIKE '% sto %' OR ${T} LIKE '%ponny%' OR ${T} LIKE '%valack%')`;
export const SEGMENT = `CASE
  WHEN ${LOT} THEN 'Partier'
  WHEN series LIKE 'bayala%' THEN 'Bayala'
  WHEN series LIKE 'eldrador%' THEN 'Eldrador'
  WHEN series LIKE 'wizarding_world%' THEN 'Harry Potter'
  WHEN series LIKE 'riddare%' THEN 'Riddartiden'
  WHEN series LIKE 'vilda_vastern%' THEN 'Vilda Västern'
  WHEN series LIKE 'peanuts%' THEN 'Snobben'
  WHEN series LIKE 'star_wars%' THEN 'Star Wars'
  WHEN niche = 'smurfar' OR series LIKE 'smurfar%' THEN 'Smurfar'
  WHEN niche = 'djur' AND ${HORSE} THEN 'Hästar'
  WHEN niche = 'djur' THEN 'Övriga djur'
  ELSE 'Övrigt' END`;

// Median per grupp med fönsterfunktioner (SQLite saknar median()).
const medianSql = (groupExpr, where) => `
  SELECT g, AVG(price) AS median FROM (
    SELECT ${groupExpr} AS g, price, ROW_NUMBER() OVER (PARTITION BY ${groupExpr} ORDER BY price) AS rn, COUNT(*) OVER (PARTITION BY ${groupExpr}) AS n
    FROM listings WHERE ${where} AND status = 'Såld' AND price > 0)
  WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY g`;

export async function marketStats(db, { days = 30 } = {}) {
  const d = days == null || days === "all" ? null : Math.max(1, Math.min(Number(days) || 30, 3650));
  // Dag för kortare perioder, vecka (från måndag) för längre.
  const bucket = (col) => (d != null && d <= 31 ? `substr(${col}, 1, 10)` : `date(substr(${col}, 1, 10), '-6 days', 'weekday 1')`);
  const q = (sql) => db.prepare(sql).bind(d);
  const [kpi, median, flow, published, dow, hour, segments, segMedian, active, upcoming] = await db.batch([
    q(`SELECT COUNT(*) AS ended, SUM(status = 'Såld') AS sold, COUNT(DISTINCT CASE WHEN status = 'Såld' THEN seller_id END) AS sellers,
         MIN(${DAY}) AS first_day FROM listings WHERE ${ENDED}`),
    q(medianSql("1", ENDED.replace("status IN ('Såld', 'Osåld') AND ", ""))),
    q(`SELECT ${bucket("end_at")} AS b, SUM(status = 'Såld') AS sold, SUM(status = 'Osåld') AS unsold FROM listings WHERE ${ENDED} GROUP BY b ORDER BY b`),
    q(`SELECT ${bucket("start_at")} AS b, COUNT(*) AS n FROM listings
       WHERE ${SCHLEICH} AND start_at IS NOT NULL AND substr(start_at, 1, 10) <= date('now')
         AND (?1 IS NULL OR substr(start_at, 1, 10) > date('now', '-' || ?1 || ' days')) GROUP BY b ORDER BY b`),
    q(`SELECT CAST(strftime('%w', ${DAY}) AS INTEGER) AS dow, COUNT(*) AS ended, SUM(status = 'Såld') AS sold FROM listings WHERE ${ENDED} GROUP BY dow`),
    q(`SELECT CAST(substr(end_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS ended, SUM(status = 'Såld') AS sold FROM listings
       WHERE ${ENDED} AND type = 'auktion' GROUP BY hour ORDER BY hour`),
    q(`SELECT ${SEGMENT} AS segment, COUNT(*) AS ended, SUM(status = 'Såld') AS sold FROM listings WHERE ${ENDED} GROUP BY segment ORDER BY sold DESC`),
    q(medianSql(SEGMENT, ENDED.replace("status IN ('Såld', 'Osåld') AND ", ""))),
    db.prepare(`SELECT ${SEGMENT} AS segment, COUNT(*) AS active FROM listings WHERE ${SCHLEICH} AND status = 'Aktiv' AND end_at >= date('now') GROUP BY segment`),
    db.prepare(
      `SELECT date(substr(end_at, 1, 10), '-6 days', 'weekday 1') AS b, COUNT(*) AS n FROM listings
       WHERE ${SCHLEICH} AND status = 'Aktiv' AND ${DAY} >= date('now') AND ${DAY} < date('now', '+63 days') GROUP BY b ORDER BY b`,
    ),
  ]);
  const k = kpi.results[0] ?? {};
  const meds = Object.fromEntries(segMedian.results.map((r) => [r.g, Math.round(r.median)]));
  const act = Object.fromEntries(active.results.map((r) => [r.segment, r.active]));
  const span = d ?? Math.max(1, Math.round((Date.now() - Date.parse(k.first_day ?? new Date().toISOString())) / 86400000));
  return {
    days: d,
    bucket: d != null && d <= 31 ? "day" : "week",
    kpi: {
      ended: k.ended ?? 0,
      sold: k.sold ?? 0,
      sell_through: k.ended ? Math.round((100 * k.sold) / k.ended) : null,
      median: median.results[0]?.median != null ? Math.round(median.results[0].median) : null,
      sellers: k.sellers ?? 0,
      first_day: k.first_day ?? null,
      active: active.results.reduce((a, r) => a + r.active, 0),
    },
    flow: flow.results,
    published: published.results,
    dow: dow.results.map((r) => ({ ...r, sell_through: r.ended ? Math.round((100 * r.sold) / r.ended) : null })),
    hour: hour.results.map((r) => ({ ...r, sell_through: r.ended >= 20 ? Math.round((100 * r.sold) / r.ended) : null })),
    segments: segments.results.map((s) => {
      const perMonth = (s.sold * 30) / span;
      return {
        ...s,
        sell_through: s.ended ? Math.round((100 * s.sold) / s.ended) : null,
        median: meds[s.segment] ?? null,
        active: act[s.segment] ?? 0,
        sold_per_month: Math.round(perMonth),
        months_of_supply: perMonth ? Math.round((10 * (act[s.segment] ?? 0)) / perMonth) / 10 : null,
      };
    }),
    upcoming: upcoming.results,
  };
}
