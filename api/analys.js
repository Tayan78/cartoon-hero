// POST /api/analys – läsåtkomst till Traderas API för analysskript (körs från
// Claude Code, inte från appen). Nycklarna stannar i Vercel.
//   Header x-analys-token: måste vara lika med ANALYS_TOKEN (saknas den är
//   funktionen avstängd och svarar 404).
//   Body { path, body?, pick? }:
//     path – bara läsanrop: /v4/items/…, /v4/users/by-alias/…, /v4/users/{id}/feedback…,
//            /v4/search…, /v4/categories…, /v4/reference-data/…
//     body – JSON för POST (bara /v4/search/advanced och /v4/search/category-count)
//     pick – fält att behålla per annons, så att svaret håller sig under Vercels gräns
// Ta bort ANALYS_TOKEN i Vercel när analysen är klar.
import { timingSafeEqual } from "node:crypto";
import { json } from "../lib/http.js";
import { traderaConfigured, traderaGet, traderaPost } from "../lib/tradera.js";

const READ_PATHS = [
  /^\/v4\/items\/\d+(\/(descriptions|restarts))?$/,
  /^\/v4\/items\/seller\/\d+(\/quick-info)?(\?[\w=&%.:+-]*)?$/,
  /^\/v4\/users\/by-alias\/[^/?]+$/,
  /^\/v4\/users\/\d+\/feedback(\/summary)?(\?[\w=&%.:+-]*)?$/,
  /^\/v4\/search(\?[\w=&%.:+-]*)?$/,
  /^\/v4\/categories(\/\d+\/attribute-definitions)?$/,
  /^\/v4\/reference-data\/[\w-]+(\?[\w=&%.:+-]*)?$/,
];
const POST_PATHS = ["/v4/search/advanced", "/v4/search/category-count"];

export function allowed(path, hasBody) {
  if (typeof path !== "string" || path.length > 500) return false;
  return hasBody ? POST_PATHS.includes(path) : READ_PATHS.some((re) => re.test(path));
}

// Behåller bara valda fält i listor med annonser (svaret eller svaret.items).
export function pickFields(data, fields) {
  if (!Array.isArray(fields) || !fields.length) return data;
  const trim = (o) => (o && typeof o === "object" ? Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]])) : o);
  if (Array.isArray(data)) return data.map(trim);
  if (Array.isArray(data?.items)) return { ...data, items: data.items.map(trim) };
  return data;
}

function tokenOk(request) {
  const expected = process.env.ANALYS_TOKEN;
  if (!expected) return false;
  const a = Buffer.from(request.headers.get("x-analys-token") ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request) {
  if (!process.env.ANALYS_TOKEN) return json({ error: "Inte aktiverat" }, 404);
  if (!tokenOk(request)) return json({ error: "Fel token" }, 401);
  if (!traderaConfigured()) return json({ error: "Tradera är inte konfigurerat" }, 400);
  const { path, body, pick } = await request.json().catch(() => ({}));
  if (!allowed(path, body != null)) return json({ error: "Anropet är inte tillåtet" }, 400);
  try {
    const data = body != null ? await traderaPost(path, body) : await traderaGet(path);
    return json({ ok: true, data: pickFields(data, pick) });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}
