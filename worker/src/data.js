// Databasen (D1) för marknadsdata. Appen på Vercel skriver och läser via de här
// adresserna (med x-app-token). Raderna skickas som JSON och skrivs med en enda
// SQL-sats per tabell (json_each), så att en hel säljare blir några få frågor.
import { marketStats } from "./analytics.js";
import { modelStats } from "./model.js";
import { own } from "./own.js";
import { ads } from "./ads.js";
import { league } from "./league.js";
import { purchases } from "./purchases.js";
import { addUsage, competitors, dashboard, productStats, recordRun, weekStats } from "./monitor.js";

export const LISTING_COLUMNS = [
  "id", "seller", "seller_id", "title", "model_number", "number_source", "type", "status", "price",
  "first_price", "lowest_price", "price_changes", "bids", "shipping", "condition", "start_at", "end_at",
  "days", "restarts", "url", "first_seen", "last_seen", "sold_seen", "text", "niche", "category_id", "raw", "source", "series",
  "description", "detail_at", "opening_price", "buy_now_price", "image_count", "reserve_met",
];
export const SELLER_COLUMNS = [
  "id", "alias", "watched", "niches", "listings_found", "active", "ended", "number_share", "rating",
  "added_at", "collected_at", "in_db", "sold_in_db", "error", "own",
];
export const MAX_ROWS = 500;

const field = (c) => `json_extract(value, '$.${c}')`;

// Upsert: saknade fält (null) skriver inte över det som redan finns. special =
// egna regler för vissa kolumner; changed = uppdatera bara om något av det ändrats.
function upsertSql(table, columns, { special = {}, changed = null, insert = {} } = {}) {
  const set = columns.filter((c) => c !== "id").map((c) => `${c} = ${special[c] ?? `COALESCE(excluded.${c}, ${table}.${c})`}`);
  return (
    `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${columns.map((c) => insert[c] ?? field(c)).join(", ")} FROM json_each(?1) WHERE ${field("id")} IS NOT NULL ` +
    `ON CONFLICT(id) DO UPDATE SET ${set.join(", ")}` +
    (changed ? ` WHERE ${changed.map((c) => `(excluded.${c} IS NOT NULL AND excluded.${c} IS NOT listings.${c})`).join(" OR ")}` : "")
  );
}

// Annonser: databasen räknar själv fram första pris, lägsta pris och antal
// prisändringar (bud på auktioner räknas inte), så att det blir rätt även för
// annonser som inte finns i arket. En oförändrad annons skrivs inte alls – det
// håller nere antalet skrivningar (D1:s gratisnivå: 100 000 rader per dygn).
// last_seen = senast annonsen ändrades.
const IS_AUCTION = "COALESCE(excluded.type, listings.type, '') = 'auktion'";
const UPSERT_LISTINGS = upsertSql("listings", LISTING_COLUMNS, {
  special: {
    first_price: "COALESCE(listings.first_price, excluded.first_price, excluded.price)",
    first_seen: "COALESCE(listings.first_seen, excluded.first_seen)",
    sold_seen: "COALESCE(listings.sold_seen, excluded.sold_seen)",
    lowest_price: `CASE WHEN excluded.price IS NULL OR ${IS_AUCTION} THEN COALESCE(listings.lowest_price, excluded.lowest_price)
      ELSE MIN(COALESCE(listings.lowest_price, excluded.price), excluded.price) END`,
    price_changes: `CASE WHEN NOT ${IS_AUCTION} AND excluded.price IS NOT NULL AND listings.price IS NOT NULL AND excluded.price <> listings.price
      THEN COALESCE(listings.price_changes, 0) + 1 ELSE COALESCE(listings.price_changes, excluded.price_changes) END`,
  },
  // Ny annons: första och lägsta pris = priset, först sedd = nu, om de inte skickats med.
  insert: {
    first_price: `COALESCE(${field("first_price")}, ${field("price")})`,
    lowest_price: `COALESCE(${field("lowest_price")}, ${field("price")})`,
    first_seen: `COALESCE(${field("first_seen")}, ${field("last_seen")})`,
  },
  changed: [
    "status", "price", "bids", "end_at", "title", "text", "model_number", "niche", "series", "shipping", "condition", "category_id",
    // url och alias räknas inte: säljarens och sökningens svar skriver dem olika, och
    // annonsen skulle då skrivas om varje natt utan att något ändrats.
    "restarts", "type", "start_at", "description", "detail_at", "opening_price", "buy_now_price", "image_count", "reserve_met",
  ],
});
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

// Observation när pris, bud eller status ändrats (eller annonsen är ny). Saknade
// värden i raden (t.ex. ingen status för avslutad Köp nu) tas från databasen.
const SNAPSHOT = `INSERT OR IGNORE INTO listing_snapshots (listing_id, seen_at, price, bids, status, source)
  SELECT j.id, j.seen, COALESCE(j.price, l.price), COALESCE(j.bids, l.bids), COALESCE(j.status, l.status), j.source
  FROM (SELECT ${field("id")} AS id, COALESCE(${field("last_seen")}, ${field("first_seen")}) AS seen, ${field("price")} AS price,
          ${field("bids")} AS bids, ${field("status")} AS status, ${field("source")} AS source FROM json_each(?1)) j
  LEFT JOIN listings l ON l.id = j.id
  WHERE j.id IS NOT NULL AND j.seen IS NOT NULL AND (l.id IS NULL
    OR COALESCE(j.price, l.price) IS NOT l.price OR COALESCE(j.bids, l.bids) IS NOT l.bids OR COALESCE(j.status, l.status) IS NOT l.status)`;

// Produktkopplingar: raderna kan ha products: [{ key, model_number, method,
// confidence, quantity?, model_version? }]. En säkrare tolkning ersätter en osäkrare.
const PRODUCT = (path) => `json_extract(p.value, '$.${path}')`;
const NEW_PRODUCTS = `INSERT OR IGNORE INTO products (key, brand, model_number, first_seen)
  SELECT ${PRODUCT("key")}, 'Schleich', ${PRODUCT("model_number")}, COALESCE(json_extract(l.value, '$.last_seen'), datetime('now'))
  FROM json_each(?1) l, json_each(l.value, '$.products') p WHERE ${PRODUCT("key")} IS NOT NULL`;
const LINKS = `INSERT INTO listing_products (listing_id, product_key, quantity, method, confidence, model_version, created_at)
  SELECT json_extract(l.value, '$.id'), ${PRODUCT("key")}, COALESCE(${PRODUCT("quantity")}, 1), ${PRODUCT("method")},
    ${PRODUCT("confidence")}, ${PRODUCT("model_version")}, datetime('now')
  FROM json_each(?1) l, json_each(l.value, '$.products') p WHERE json_extract(l.value, '$.id') IS NOT NULL AND ${PRODUCT("key")} IS NOT NULL
  ON CONFLICT(listing_id, product_key) DO UPDATE SET quantity = excluded.quantity, method = excluded.method,
    confidence = excluded.confidence, model_version = excluded.model_version
  WHERE COALESCE(excluded.confidence, 0) > COALESCE(listing_products.confidence, 0)`;

// Rader som D1 faktiskt skrev (för översikten; D1:s gratisgräns är 100 000 per dygn).
const rowsWritten = (r) => Number(r?.meta?.rows_written) || 0;
const written = (results) => [].concat(results).reduce((sum, r) => sum + rowsWritten(r), 0);

// Skrivbudget per dygn (UTC, som Cloudflare räknar): stora skrivningar (annonser,
// kopplingar, kategorier) stoppas innan gratisgränsen nås. Små skrivningar
// (körningar, inköp, ditt konto, räknare) går alltid igenom.
export const DAILY_WRITE_BUDGET = 1_000_000; // Workers Paid: 50 milj. per månad – spärren skyddar mot loopar
export async function writtenToday(db, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const { results } = await db.prepare("SELECT count FROM usage WHERE day = ?1 AND api = 'd1_rows'").bind(day).all();
  return Number(results[0]?.count) || 0;
}

export async function upsertListings(db, rows) {
  const json = JSON.stringify(rows);
  const results = await db.batch([
    db.prepare(FIRST_PRICE).bind(json),
    db.prepare(PRICE_CHANGE).bind(json),
    db.prepare(SNAPSHOT).bind(json),
    db.prepare(UPSERT_LISTINGS).bind(json),
    db.prepare(NEW_PRODUCTS).bind(json),
    db.prepare(LINKS).bind(json),
  ]);
  const [first, change, snap, upsert, products, links] = results.map(rowsWritten);
  // Per del, så att Drift kan visa vad som skriver mest.
  const parts = { d1_rows_prices: first + change, d1_rows_snapshots: snap, d1_rows_listings: upsert, d1_rows_links: products + links };
  return { rows: rows.length, written: written(results), parts };
}

// Bara produktkopplingar (efterhandskoppling av annonser som redan finns).
export async function linkProducts(db, rows) {
  const json = JSON.stringify(rows);
  const results = await db.batch([db.prepare(NEW_PRODUCTS).bind(json), db.prepare(LINKS).bind(json)]);
  return { rows: rows.length, written: written(results) };
}

// Schleich-annonser i id-ordning (för efterhandskopplingen), bara de som saknar
// produkt om unlinked.
export async function listingTexts(db, { after = "", limit = 1000, unlinked = false } = {}) {
  const { results } = await db
    .prepare(
      `SELECT id, title, COALESCE(description, text) AS text FROM listings WHERE id > ?1 AND (niche IS NOT NULL OR series IS NOT NULL OR source = 'sök')
         ${unlinked ? "AND NOT EXISTS (SELECT 1 FROM listing_products lp WHERE lp.listing_id = listings.id)" : ""}
       ORDER BY id LIMIT ?2`,
    )
    .bind(String(after), Math.min(Number(limit) || 1000, 2000))
    .all();
  return { rows: results, next: results.length ? results[results.length - 1].id : null };
}

// Schleich-annonser vars annonsdetalj inte hämtats än – nyast först, så att nya
// annonser får sin detalj samma natt och historiken tas i mån av utrymme.
export async function needsDetail(db, { limit = 500 } = {}) {
  const { results } = await db
    .prepare(
      // Dina bevakade säljare och ditt konto först, sedan nyast först.
      `SELECT id FROM listings WHERE detail_at IS NULL AND (niche IS NOT NULL OR series IS NOT NULL OR source = 'sök')
       ORDER BY (seller_id IN (SELECT id FROM sellers WHERE watched = 1 OR own = 1)) DESC, first_seen DESC, id DESC LIMIT ?1`,
    )
    .bind(Math.min(Number(limit) || 500, 2000))
    .all();
  return { ids: results.map((r) => r.id) };
}

// Traderas kategorier (id, namn, förälder, sökväg).
export async function upsertCategories(db, rows) {
  const result = await db
    .prepare(
      `INSERT INTO categories (id, name, parent_id, path) SELECT ${field("id")}, ${field("name")}, ${field("parent_id")}, ${field("path")}
       FROM json_each(?1) WHERE ${field("id")} IS NOT NULL
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id, path = excluded.path
       WHERE name IS NOT excluded.name OR parent_id IS NOT excluded.parent_id OR path IS NOT excluded.path`,
    )
    .bind(JSON.stringify(rows))
    .run();
  return { rows: rows.length, written: written(result) };
}

export async function upsertSellers(db, rows) {
  const result = await db.prepare(UPSERT_SELLERS).bind(JSON.stringify(rows)).run();
  return { rows: rows.length, written: written(result) };
}

// Säljarna med siffror ur databasen (bevakade, ditt konto och övriga kända).
export async function sellerList(db, { watched = false } = {}) {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.alias, s.watched, s.own, s.niches, s.listings_found, s.active, s.ended, s.number_share, s.rating,
         s.added_at, s.collected_at, s.error,
         (SELECT COUNT(*) FROM listings l WHERE l.seller_id = s.id) AS in_db,
         (SELECT COUNT(*) FROM listings l WHERE l.seller_id = s.id AND l.status = 'Såld') AS sold_in_db
       FROM sellers s ${watched ? "WHERE s.watched = 1 OR s.own = 1" : ""} ORDER BY s.alias`,
    )
    .all();
  return { sellers: results };
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

// Avslutade Köp nu-annonser där vi ännu inte vet om de sålts (sökningen säger
// inte det – annonsdetaljen gör). Äldst först.
export async function unresolvedListings(db, { limit = 500, now = new Date().toISOString() } = {}) {
  const { results } = await db
    .prepare(
      `SELECT id FROM listings WHERE COALESCE(type, '') <> 'auktion' AND end_at IS NOT NULL AND end_at < ?1
         AND (status IS NULL OR status = 'Aktiv') ORDER BY end_at LIMIT ?2`,
    )
    .bind(now, Math.min(Number(limit) || 500, 2000))
    .all();
  return { ids: results.map((r) => r.id) };
}

// /data/status och /data/dashboard (GET), /data/listings och /data/sellers (POST
// { rows }), /data/query, /data/unresolved, /data/usage och /data/run (POST).
// extra.watcher = bevakningens status (till översikten).
export async function handleData(request, env, path, extra = {}) {
  if (!env.DB) return Response.json({ ok: false, error: "Databasen (DB) är inte kopplad" }, { status: 500 });
  try {
    if (path === "/data/status") return Response.json({ ok: true, ...(await dbStatus(env.DB)) });
    if (path === "/data/dashboard") return Response.json({ ok: true, ...(await dashboard(env.DB)), watcher: extra.watcher ?? null });
    if (request.method !== "POST") return Response.json({ ok: false, error: "POST krävs" }, { status: 405 });
    const body = await request.json();
    if (path === "/data/query") return Response.json({ ok: true, ...(await queryListings(env.DB, body)) });
    if (path === "/data/unresolved") return Response.json({ ok: true, ...(await unresolvedListings(env.DB, body)) });
    if (path === "/data/usage") return Response.json({ ok: true, ...(await addUsage(env.DB, body.counts)) });
    if (path === "/data/run") return Response.json({ ok: true, ...(await recordRun(env.DB, body)) });
    if (path === "/data/competitors") return Response.json({ ok: true, ...(await competitors(env.DB, body)) });
    if (path === "/data/ads") return Response.json({ ok: true, ...(await ads(env, body)) });
    if (path === "/data/seller-list") return Response.json({ ok: true, ...(await sellerList(env.DB, body)) });
    if (path === "/data/own") return Response.json({ ok: true, ...(await own(env.DB, body)) });
    if (path === "/data/model") return Response.json({ ok: true, ...(await modelStats(env.DB, body)) });
    if (path === "/data/league") return Response.json({ ok: true, ...(await league(env.DB, body)) });
    if (path === "/data/week") return Response.json({ ok: true, ...(await weekStats(env.DB, body)) });
    if (path === "/data/products") return Response.json({ ok: true, ...(await productStats(env.DB, body)) });
    if (path === "/data/texts") return Response.json({ ok: true, ...(await listingTexts(env.DB, body)) });
    if (path === "/data/purchases") return Response.json({ ok: true, ...(await purchases(env.DB, body)) });
    if (path === "/data/market") return Response.json({ ok: true, ...(await marketStats(env.DB, body)) });
    if (path === "/data/needs-detail") return Response.json({ ok: true, ...(await needsDetail(env.DB, body)) });
    const { rows } = body;
    if (!Array.isArray(rows)) return Response.json({ ok: false, error: "rows saknas" }, { status: 400 });
    if (rows.length > MAX_ROWS) return Response.json({ ok: false, error: `Högst ${MAX_ROWS} rader per anrop` }, { status: 400 });
    if (["/data/listings", "/data/sellers", "/data/links", "/data/categories"].includes(path)) {
      const write = { "/data/listings": upsertListings, "/data/sellers": upsertSellers, "/data/links": linkProducts, "/data/categories": upsertCategories }[path];
      const budget = Number(env.DAILY_WRITE_BUDGET) || DAILY_WRITE_BUDGET;
      if (path !== "/data/sellers") {
        const today = await writtenToday(env.DB).catch(() => 0);
        if (today >= budget) {
          return Response.json({ ok: false, error: `Dygnets skrivbudget i databasen är slut (${today} av ${budget} rader) – fortsätter efter midnatt (UTC)`, budget: true }, { status: 429 });
        }
      }
      const out = await write(env.DB, rows);
      await addUsage(env.DB, { d1_rows: out.written, ...(out.parts ?? {}) }).catch(() => {});
      return Response.json({ ok: true, ...out });
    }
    return Response.json({ ok: false, error: "Okänd adress" }, { status: 404 });
  } catch (err) {
    return Response.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
