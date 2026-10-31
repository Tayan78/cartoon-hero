// Ditt Tradera-konto via Traderas egen inloggning (token login):
// 1. Appen öppnar https://api.tradera.com/token-login?appId=…&pkey=…&skey=… –
//    skey är en engångsnyckel som appen hittar på. Du loggar in och godkänner.
// 2. Servern hämtar nyckeln (token) med samma skey: POST /v4/auth/token.
//    Den sparas i databasen, aldrig i appen.
// 3. Varje natt hämtas dina ordrar (GET /v4/orders) – det verkliga priset per
//    sålt objekt, även när du tackat ja till ett prisförslag. Köparens namn och
//    adress kastas direkt, bara annons, pris, frakt och datum sparas.
import { dbConfigured, dbOwn } from "./db.js";
import { countUsage } from "./usage.js";

const BASE_URL = process.env.TRADERA_BASE_URL || "https://api.tradera.com";
export const LOGIN_URL = "https://api.tradera.com/token-login";
export const connectConfigured = () => Boolean(process.env.TRADERA_APP_ID && process.env.TRADERA_APP_KEY && process.env.TRADERA_PUBLIC_KEY);

// Det appen behöver för att öppna inloggningen (inga hemligheter: app-id och publik nyckel).
export const connectInfo = () => (connectConfigured() ? { url: LOGIN_URL, app_id: String(process.env.TRADERA_APP_ID), pkey: process.env.TRADERA_PUBLIC_KEY } : null);

async function call(path, { method = "GET", body, user } = {}, fetchImpl = fetch) {
  countUsage(path.startsWith("/v4/orders") ? "tradera_orders" : "tradera_auth");
  const res = await fetchImpl(`${BASE_URL}${path}`, {
    method,
    headers: {
      "X-App-Id": String(process.env.TRADERA_APP_ID),
      "X-App-Key": process.env.TRADERA_APP_KEY,
      Accept: "application/json",
      ...(user ? { "X-User-Id": String(user.user_id), "X-User-Token": user.token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = data?.title || data?.message || data?.error?.message || text.slice(0, 120) || "fel";
    const err = new Error(`Tradera ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const pick = (o, k) => o?.[k] ?? o?.[k[0].toUpperCase() + k.slice(1)];
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

// Steg 2: nyckeln för ditt konto. userId = Joulupukkins id.
export async function fetchUserToken({ userId, skey }, fetchImpl = fetch) {
  if (!/^[\w-]{32,255}$/.test(String(skey ?? ""))) throw new Error("Ogiltig engångsnyckel – tryck Koppla igen.");
  const t = await call("/v4/auth/token", { method: "POST", body: { userId: Number(userId), secretKey: String(skey) } }, fetchImpl);
  const token = pick(t, "authToken");
  if (!token) throw new Error("Tradera gav ingen nyckel – har du godkänt i Tradera-fönstret?");
  return { token: String(token), expires: pick(t, "hardExpirationTime") ?? null };
}

// En order → en rad per sålt objekt. Bara det som behövs; köpare och adress följer aldrig med.
export function saleRows(orders) {
  const out = [];
  for (const o of Array.isArray(orders) ? orders : []) {
    const payments = pick(o, "sellerOrderPayments") ?? [];
    const paid = payments.map((p) => pick(p, "paidDate")).filter(Boolean).sort();
    const paidAmount = payments.reduce((s, p) => s + (int(pick(p, "amount")) ?? 0), 0);
    for (const i of pick(o, "items") ?? []) {
      if (pick(i, "itemId") == null) continue;
      out.push({
        order_id: int(pick(o, "orderId")),
        item_id: String(pick(i, "itemId")),
        title: String(pick(i, "title") ?? "").slice(0, 200),
        quantity: int(pick(i, "quantity")) ?? 1,
        unit_price: int(pick(i, "unitPrice")),
        order_total: int(pick(o, "subTotal")),
        shipping_cost: int(pick(o, "shippingCost")),
        shipping_type: pick(o, "shippingType") ?? null,
        paid_amount: paidAmount || null,
        paid_at: paid[paid.length - 1] ?? null,
        created_at: pick(o, "createdDate") ?? null,
        updated_at: pick(o, "lastUpdatedDate") ?? null,
      });
    }
  }
  return out;
}

const DAY = 86400000;
export const FIRST_SYNC_DAYS = 120; // första gången: så långt bakåt (sedan från förra hämtningen)
const WINDOW_DAYS = 30;

// Steg 3: ordrar som ändrats sedan förra hämtningen (2 dygns överlapp), i 30-dagarsfönster.
export async function syncOwnOrders({ now = Date.now(), own = dbOwn, fetchImpl = fetch } = {}) {
  if (!dbConfigured() || !process.env.TRADERA_APP_ID) return { skipped: "inte konfigurerat" };
  const { auth } = await own({ op: "auth_get" });
  if (!auth?.token) return { skipped: "kontot är inte kopplat" };
  if (auth.expires && Date.parse(auth.expires) < now) return { skipped: "nyckeln har gått ut – koppla kontot igen" };
  const status = await own({ op: "status" });
  const last = status.sync?.synced_at ? Date.parse(status.sync.synced_at) - 2 * DAY : now - FIRST_SYNC_DAYS * DAY;
  const rows = [];
  for (let from = last; from < now; from += WINDOW_DAYS * DAY) {
    const to = Math.min(from + WINDOW_DAYS * DAY, now);
    const q = new URLSearchParams({ fromDate: new Date(from).toISOString(), toDate: new Date(to).toISOString(), queryDateMode: "1" });
    try {
      rows.push(...saleRows(await call(`/v4/orders?${q}`, { user: auth }, fetchImpl)));
    } catch (err) {
      if (err.status === 401 || err.status === 403) return { error: "Tradera godtar inte nyckeln – koppla kontot igen" };
      throw err;
    }
  }
  for (let i = 0; i < rows.length; i += 400) await own({ op: "sales_upsert", rows: rows.slice(i, i + 400) });
  await own({ op: "sales_upsert", rows: [], synced_at: new Date(now).toISOString() });
  return { fetched: rows.length };
}
