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

// Månaden (offset 0 = denna, -1 = förra), svensk tid.
const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
export function monthBounds(now = Date.now(), offset = 0) {
  const local = new Date(now + stockholmOffset(now) * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() + offset;
  const first = (yy, mm) => {
    const guess = Date.UTC(yy, mm, 1);
    return guess - stockholmOffset(guess) * 60000;
  };
  const start = first(y, m);
  const end = first(y, m + 1);
  const s = new Date(start + stockholmOffset(start) * 60000);
  const days = Math.round((end - start) / DAY);
  return { start, end, month: s.getUTCMonth() + 1, label: MONTHS[s.getUTCMonth()], year: s.getUTCFullYear(), day: offset === 0 ? local.getUTCDate() : days, days, today: localMidnight(now) };
}

const iso = (ms) => new Date(ms).toISOString();

// Alla säljare med sålda annonser mellan from och to, rangordnade på omsättning
// (standard) eller antal.
async function ranking(db, from, to, metric = "revenue") {
  const order = metric === "count" ? "sold DESC, revenue DESC" : "revenue DESC, sold DESC";
  const { results } = await db
    .prepare(
      `SELECT l.seller_id AS id, MAX(l.seller) AS alias, COUNT(*) AS sold, COALESCE(SUM(l.price), 0) AS revenue, COALESCE(MAX(s.own), 0) AS own
       FROM listings l LEFT JOIN sellers s ON s.id = l.seller_id
       WHERE ${SOLD} AND julianday(l.end_at) >= julianday(?1) AND julianday(l.end_at) < julianday(?2)
       GROUP BY l.seller_id ORDER BY ${order}`,
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

// period: "week" (måndag–söndag) eller "month". offset 0 = pågående, -1 = förra.
export async function league(db, { period = "week", offset, week = 0, metric = "revenue", now = Date.now(), history } = {}) {
  const monthly = period === "month";
  const by = metric === "count" ? "count" : "revenue";
  const rank = (from, to) => ranking(db, from, to, by);
  const off = Math.min(0, Math.max(-52, Number(offset ?? week) || 0));
  const bounds = (o) => (monthly ? monthBounds(now, o) : weekBounds(now, o));
  const w = bounds(off);
  const cutoff = off === 0 ? Math.min(now, w.end) : w.end;
  const [list, market, ownRow] = await Promise.all([
    rank(w.start, cutoff),
    totals(db, w.start, cutoff),
    db.prepare("SELECT id, alias FROM sellers WHERE own = 1 LIMIT 1").all(),
  ]);
  const own = ownRow.results[0] ?? null;
  const me = list.find((r) => r.own) ?? null;
  const out = {
    period: monthly ? "month" : "week",
    metric: by,
    ...(monthly ? { month: w.month, label: w.label, days: w.days } : { week: w.week, days: 7 }),
    year: w.year,
    start: iso(w.start),
    end: iso(w.end - 1),
    day: w.day,
    final: off < 0,
    own,
    market,
    mine: { sold: me?.sold ?? 0, revenue: me?.revenue ?? 0, rank: me?.rank ?? null, share: market.sold ? Math.round((1000 * (me?.sold ?? 0)) / market.sold) / 10 : 0 },
    sellers: list.length,
  };

  if (off === 0) {
    // Förändring sedan i går och jämförelse mot samma tid in i förra perioden.
    const prev = bounds(-1);
    const prevCut = Math.min(prev.end, prev.start + (cutoff - w.start));
    const [yesterday, lastPeriod, lastMine] = await Promise.all([
      w.today > w.start ? rank(w.start, w.today) : null,
      totals(db, prev.start, prevCut),
      rank(prev.start, prevCut).then((l) => l.find((r) => r.own) ?? null),
    ]);
    out.top = board(list, yesterday);
    out.market.prev = lastPeriod.sold;
    out.market.prev_revenue = lastPeriod.revenue;
    out.mine.prev = lastMine?.sold ?? 0;
    out.mine.prev_revenue = lastMine?.revenue ?? 0;
    if (me && me.rank > 1) {
      const ahead = list[me.rank - 2];
      out.mine.to_next =
        by === "count"
          ? { alias: ahead.alias, rank: ahead.rank, needed: ahead.sold - me.sold + 1, unit: "st" }
          : { alias: ahead.alias, rank: ahead.rank, needed: ahead.revenue - me.revenue + 1, unit: "kr" };
    }
  } else {
    out.top = board(list);
  }

  // Din historik: placering period för period (avslutade perioder).
  const count = history ?? (monthly ? 6 : 8);
  if (own && count > 0) {
    const periods = [];
    for (let i = 1; i <= count; i++) {
      const b = bounds(Math.min(off, 0) - i + (off < 0 ? 1 : 0));
      if (b.start === w.start) continue;
      const l = await rank(b.start, b.end);
      const r = l.find((x) => x.own);
      periods.push({ ...(monthly ? { month: b.month, label: b.label } : { week: b.week }), rank: r?.rank ?? null, sold: r?.sold ?? 0, sellers: l.length });
    }
    const placed = periods.filter((x) => x.rank);
    const best = placed.reduce((a, x) => (!a || x.rank < a.rank ? x : a), null);
    let streak = 0;
    for (const x of periods) {
      if (x.rank && x.rank <= 3) streak++;
      else break;
    }
    out.history = {
      ...(monthly ? { months: periods } : { weeks: periods }),
      best: best ? { ...(monthly ? { month: best.month, label: best.label } : { week: best.week }), rank: best.rank } : null,
      top3_streak: streak,
    };
  }
  return out;
}
