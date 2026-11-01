// Veckoligan på Hem: sålda Schleich-annonser per säljare vecka för vecka
// (måndag–söndag, svensk tid). Placering, förändring sedan i går, hur många som
// fattas till nästa placering, förra veckans slutresultat och din historik.

const SCHLEICH = "(l.niche IS NOT NULL OR l.series IS NOT NULL OR l.source = 'sök')";
const SOLD = `l.status = 'Såld' AND ${SCHLEICH} AND l.seller_id IS NOT NULL`;
const DAY = 86400000;
export const TOP_N = 10;

// Svensk tid: förskjutning i minuter mot UTC vid en viss tidpunkt (sommar/vintertid).
export function stockholmOffset(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Stockholm", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((local - Math.floor(ms / 60000) * 60000) / 60000);
}

// Midnatt (svensk tid) för det lokala datumet vid tidpunkten ms, som UTC-tid.
function localMidnight(ms) {
  const local = new Date(ms + stockholmOffset(ms) * 60000);
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return guess - stockholmOffset(guess) * 60000;
}

// ISO-veckonummer för ett datum (lokalt).
function isoWeek(y, m, d) {
  const date = new Date(Date.UTC(y, m, d));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return { week: Math.ceil(((date - yearStart) / DAY + 1) / 7), year: date.getUTCFullYear() };
}

// Veckan (offset 0 = denna, -1 = förra): start/slut som UTC-tid, nummer och dag i veckan.
export function weekBounds(now = Date.now(), offset = 0) {
  const local = new Date(now + stockholmOffset(now) * 60000);
  const dow = local.getUTCDay() || 7; // 1 = måndag
  const today = localMidnight(now);
  const monday = localMidnight(today - (dow - 1) * DAY + 12 * 3600000 + offset * 7 * DAY);
  const nextMonday = localMidnight(monday + 7 * DAY + 12 * 3600000);
  const m = new Date(monday + stockholmOffset(monday) * 60000);
  const { week, year } = isoWeek(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate());
  return { start: monday, end: nextMonday, week, year, day: offset === 0 ? dow : 7, today };
}

const iso = (ms) => new Date(ms).toISOString();

// Alla säljare med sålda annonser mellan from och to, rangordnade.
async function ranking(db, from, to) {
  const { results } = await db
    .prepare(
      `SELECT l.seller_id AS id, MAX(l.seller) AS alias, COUNT(*) AS sold, SUM(l.price) AS revenue, COALESCE(MAX(s.own), 0) AS own
       FROM listings l LEFT JOIN sellers s ON s.id = l.seller_id
       WHERE ${SOLD} AND julianday(l.end_at) >= julianday(?1) AND julianday(l.end_at) < julianday(?2)
       GROUP BY l.seller_id ORDER BY sold DESC, revenue DESC`,
    )
    .bind(iso(from), iso(to))
    .all();
  return results.map((r, i) => ({ ...r, rank: i + 1, own: Number(r.own) === 1 }));
}

async function totals(db, from, to) {
  const { results } = await db
    .prepare(`SELECT COUNT(*) AS sold, SUM(l.price) AS revenue FROM listings l WHERE ${SOLD} AND julianday(l.end_at) >= julianday(?1) AND julianday(l.end_at) < julianday(?2)`)
    .bind(iso(from), iso(to))
    .all();
  return { sold: results[0]?.sold ?? 0, revenue: results[0]?.revenue ?? 0 };
}

// Topp N + din rad (om du är längre ner), med förändring mot en tidigare ställning.
function board(list, before = null) {
  const prev = before ? new Map(before.map((r) => [r.id, r.rank])) : null;
  return list
    .filter((r) => r.rank <= TOP_N || r.own)
    .map((r) => ({ id: r.id, alias: r.alias, sold: r.sold, revenue: r.revenue ?? 0, rank: r.rank, own: r.own, ...(prev ? { move: prev.has(r.id) ? prev.get(r.id) - r.rank : null } : {}) }));
}

export async function league(db, { week = 0, now = Date.now(), history = 8 } = {}) {
  const offset = Math.min(0, Math.max(-52, Number(week) || 0));
  const w = weekBounds(now, offset);
  const cutoff = offset === 0 ? Math.min(now, w.end) : w.end;
  const [list, market, ownRow] = await Promise.all([
    ranking(db, w.start, cutoff),
    totals(db, w.start, cutoff),
    db.prepare("SELECT id, alias FROM sellers WHERE own = 1 LIMIT 1").all(),
  ]);
  const own = ownRow.results[0] ?? null;
  const me = list.find((r) => r.own) ?? null;
  const out = {
    week: w.week,
    year: w.year,
    start: iso(w.start),
    end: iso(w.end - 1),
    day: w.day,
    final: offset < 0,
    own,
    market,
    mine: { sold: me?.sold ?? 0, revenue: me?.revenue ?? 0, rank: me?.rank ?? null, share: market.sold ? Math.round((1000 * (me?.sold ?? 0)) / market.sold) / 10 : 0 },
    sellers: list.length,
  };

  if (offset === 0) {
    // Förändring sedan i går (ställningen vid midnatt i dag) och jämförelse mot samma dag förra veckan.
    const [yesterday, lastWeek, lastWeekMine] = await Promise.all([
      w.today > w.start ? ranking(db, w.start, w.today) : null,
      totals(db, w.start - 7 * DAY, cutoff - 7 * DAY),
      ranking(db, w.start - 7 * DAY, cutoff - 7 * DAY).then((l) => l.find((r) => r.own)?.sold ?? 0),
    ]);
    out.top = board(list, yesterday);
    out.market.prev = lastWeek.sold;
    out.mine.prev = lastWeekMine;
    if (me && me.rank > 1) {
      const ahead = list[me.rank - 2];
      out.mine.to_next = { alias: ahead.alias, rank: ahead.rank, needed: ahead.sold - me.sold + 1 };
    }
  } else {
    out.top = board(list);
  }

  // Din historik: placering vecka för vecka (avslutade veckor).
  if (own && history > 0) {
    const weeks = [];
    for (let i = 1; i <= history; i++) {
      const b = weekBounds(now, offset - i + (offset < 0 ? 1 : 0));
      if (b.start === w.start) continue;
      const l = await ranking(db, b.start, b.end);
      const r = l.find((x) => x.own);
      weeks.push({ week: b.week, rank: r?.rank ?? null, sold: r?.sold ?? 0, sellers: l.length });
    }
    const placed = weeks.filter((x) => x.rank);
    const best = placed.reduce((a, x) => (!a || x.rank < a.rank ? x : a), null);
    let streak = 0;
    for (const x of weeks) {
      if (x.rank && x.rank <= 3) streak++;
      else break;
    }
    out.history = { weeks, best: best ? { week: best.week, rank: best.rank } : null, top3_streak: streak };
  }
  return out;
}
