// Databasen (D1) för marknadsdata. Appen på Vercel skriver och läser via de här
// adresserna (med x-app-token). Raderna skickas som JSON och skrivs med en enda
// SQL-sats per tabell (json_each), så att en hel säljare blir några få frågor.

export const LISTING_COLUMNS = [
  "id", "seller", "seller_id", "title", "model_number", "number_source", "type", "status", "price",
  "first_price", "lowest_price", "price_changes", "bids", "shipping", "condition", "start_at", "end_at",
  "days", "restarts", "url", "first_seen", "last_seen", "sold_seen", "text", "niche", "category_id",
];
export const SELLER_COLUMNS = [
  "id", "alias", "watched", "niches", "listings_found", "active", "ended", "number_share", "rating",
  "added_at", "collected_at", "in_db", "sold_in_db", "error",
];
export const MAX_ROWS = 500;

const field = (c) => `json_extract(value, '$.${c}')`;

// Upsert: saknade fält (null) skriver inte över det som redan finns.
function upsertSql(table, columns) {
  const set = columns.filter((c) => c !== "id").map((c) => `${c} = COALESCE(excluded.${c}, ${table}.${c})`);
  return (
    `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${columns.map(field).join(", ")} FROM json_each(?1) WHERE ${field("id")} IS NOT NULL ` +
    `ON CONFLICT(id) DO UPDATE SET ${set.join(", ")}`
  );
}
const UPSERT_LISTINGS = upsertSql("listings", LISTING_COLUMNS);
const UPSERT_SELLERS = upsertSql("sellers", SELLER_COLUMNS);

// Prishistorik, före upserten: första priset för nya annonser, och nuvarande pris
// om det skiljer sig från det som står i databasen.
const FIRST_PRICE = `INSERT OR IGNORE INTO price_history (listing_id, seen_at, price)
  SELECT ${field("id")}, ${field("first_seen")}, ${field("first_price")} FROM json_each(?1)
  WHERE ${field("first_price")} IS NOT NULL AND ${field("first_seen")} IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.id = ${field("id")})`;
const PRICE_CHANGE = `INSERT OR IGNORE INTO price_history (listing_id, seen_at, price)
  SELECT ${field("id")}, ${field("last_seen")}, ${field("price")} FROM json_each(?1)
  WHERE ${field("price")} IS NOT NULL AND ${field("last_seen")} IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.id = ${field("id")} AND l.price = ${field("price")})`;

export async function upsertListings(db, rows) {
  const json = JSON.stringify(rows);
  await db.batch([db.prepare(FIRST_PRICE).bind(json), db.prepare(PRICE_CHANGE).bind(json), db.prepare(UPSERT_LISTINGS).bind(json)]);
  return { rows: rows.length };
}

export async function upsertSellers(db, rows) {
  await db.prepare(UPSERT_SELLERS).bind(JSON.stringify(rows)).run();
  return { rows: rows.length };
}

export async function dbStatus(db) {
  const [totals, niches, sellers, prices] = await db.batch([
    db.prepare("SELECT COUNT(*) AS listings, SUM(status = 'Såld') AS sold, SUM(status = 'Aktiv') AS active, MAX(last_seen) AS last_seen FROM listings"),
    db.prepare("SELECT COALESCE(niche, '') AS niche, COUNT(*) AS listings, SUM(status = 'Såld') AS sold FROM listings GROUP BY niche ORDER BY listings DESC"),
    db.prepare("SELECT COUNT(*) AS sellers, SUM(watched = 1) AS watched FROM sellers"),
    db.prepare("SELECT COUNT(*) AS price_points FROM price_history"),
  ]);
  const t = totals.results[0] ?? {};
  return {
    listings: t.listings ?? 0,
    sold: t.sold ?? 0,
    active: t.active ?? 0,
    last_seen: t.last_seen ?? null,
    niches: niches.results,
    sellers: sellers.results[0]?.sellers ?? 0,
    watched: sellers.results[0]?.watched ?? 0,
    price_points: prices.results[0]?.price_points ?? 0,
  };
}

// Annonser med vissa statusar (t.ex. Såld/Osåld) – underlaget för styckpriserna.
export const QUERY_COLUMNS = ["id", "seller_id", "title", "model_number", "status", "price", "niche", "text"];
export async function queryListings(db, { statuses = [] } = {}) {
  const list = statuses.map(String).slice(0, 10);
  if (!list.length) return { rows: [] };
  const sql = `SELECT ${QUERY_COLUMNS.join(", ")} FROM listings WHERE status IN (${list.map(() => "?").join(", ")})`;
  const { results } = await db.prepare(sql).bind(...list).all();
  return { rows: results };
}

// /data/status (GET), /data/listings och /data/sellers (POST { rows }),
// /data/query (POST { statuses }).
export async function handleData(request, env, path) {
  if (!env.DB) return Response.json({ ok: false, error: "Databasen (DB) är inte kopplad" }, { status: 500 });
  try {
    if (path === "/data/status") return Response.json({ ok: true, ...(await dbStatus(env.DB)) });
    if (request.method !== "POST") return Response.json({ ok: false, error: "POST krävs" }, { status: 405 });
    const body = await request.json();
    if (path === "/data/query") return Response.json({ ok: true, ...(await queryListings(env.DB, body)) });
    const { rows } = body;
    if (!Array.isArray(rows)) return Response.json({ ok: false, error: "rows saknas" }, { status: 400 });
    if (rows.length > MAX_ROWS) return Response.json({ ok: false, error: `Högst ${MAX_ROWS} rader per anrop` }, { status: 400 });
    if (path === "/data/listings") return Response.json({ ok: true, ...(await upsertListings(env.DB, rows)) });
    if (path === "/data/sellers") return Response.json({ ok: true, ...(await upsertSellers(env.DB, rows)) });
    return Response.json({ ok: false, error: "Okänd adress" }, { status: 404 });
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
