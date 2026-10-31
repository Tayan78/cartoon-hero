// Annonsdetaljen (GET /v4/items/{id}) för Schleich-annonser från sökningen, som
// bara ger rubrik och pris. Detaljen ger hela beskrivningen (där modellnumret ofta
// står), startdatum, utropspris, Köp nu-pris, frakt, antal bilder, reservpris och
// det verifierade utfallet (gotWinner). Nyast först; historiken tas i mån av
// utrymme (Traderas gräns: 10 000 detaljer per dygn, delas med Fynd m.fl.).
import { dbConfigured, dbNeedsDetail, dbPut, dbRun } from "./db.js";
import { productLinks } from "./products.js";
import { conditionText } from "./seller.js";
import { traderaGet } from "./tradera.js";

export const DETAIL_PER_STEP = 700; // per anrop till servern (~30 s, ryms i 120 s)
export const DETAIL_PER_NIGHT = 2500;

const pick = (o, k) => o?.[k] ?? o?.[k[0].toUpperCase() + k.slice(1)];
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
const plain = (html) => String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function shippingOf(item) {
  const costs = (pick(item, "shippingOptions") ?? []).map((o) => Number(pick(o, "cost"))).filter((c) => Number.isFinite(c) && c > 0);
  return costs.length ? Math.min(...costs) : null;
}

// Annonsdetalj → fält i databasen. Beskrivningen sparas som Tradera gav den.
export function detailRow(id, item, now = Date.now()) {
  const stamp = new Date(now).toISOString();
  const title = String(pick(item, "shortDescription") ?? "");
  const description = String(pick(item, "longDescription") ?? "");
  const end = Date.parse(pick(item, "endDate") ?? "");
  const won = pick(pick(item, "status"), "gotWinner");
  const ended = pick(pick(item, "status"), "ended") === true || (Number.isFinite(end) && end < now);
  const reserve = pick(item, "reservePriceReached");
  const status = ended && typeof won === "boolean" ? (won ? "Såld" : "Osåld") : null;
  return {
    id: String(id),
    description,
    text: plain(description).slice(0, 500) || null,
    start_at: pick(item, "startDate") ?? null,
    opening_price: num(pick(item, "openingBid")),
    buy_now_price: num(pick(item, "buyItNowPrice")),
    shipping: shippingOf(item),
    image_count: (pick(item, "imageLinks") ?? []).length || null,
    restarts: Number.isFinite(Number(pick(item, "restarts"))) ? Number(pick(item, "restarts")) : null,
    reserve_met: typeof reserve === "boolean" && num(pick(item, "reservePrice")) ? (reserve ? 1 : 0) : null,
    condition: conditionText(pick(item, "attributeValues")) || null,
    ...(status ? { status, ...(status === "Såld" ? { sold_seen: stamp } : {}) } : {}),
    detail_at: stamp,
    last_seen: stamp,
    products: productLinks({ title, text: description }),
  };
}

// Ett steg: hämtar detaljen för upp till max annonser och skriver dem. En annons
// som inte finns kvar hos Tradera markeras som hämtad (försöks inte igen).
export async function fetchDetails({ max = DETAIL_PER_STEP, get = traderaGet, need = dbNeedsDetail, put = dbPut, now = Date.now() } = {}) {
  if (need === dbNeedsDetail && !dbConfigured()) return { checked: 0, fetched: 0, missing: 0, errors: 0, linked: 0 };
  const ids = await need(max);
  const rows = [];
  let missing = 0;
  let errors = 0;
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(
      ids.slice(i, i + 10).map((id) =>
        get(`/v4/items/${id}`).then(
          (item) => rows.push(detailRow(id, item, now)),
          (err) => {
            if (/ 404|hittades inte|not found/i.test(err.message)) {
              missing++;
              rows.push({ id: String(id), detail_at: new Date(now).toISOString() });
            } else errors++;
          },
        ),
      ),
    );
  }
  await put("listings", rows);
  return { checked: ids.length, fetched: rows.length - missing, missing, errors, linked: rows.filter((r) => r.products?.length).length, more: ids.length === max };
}

// Nattens körning i steg (varje steg är ett eget anrop till servern). state
// följer med mellan stegen; next() startar nästa steg.
export async function detailStep(state = {}, { step = fetchDetails, history = dbRun, next = async () => {}, perNight = DETAIL_PER_NIGHT, clock = Date.now } = {}) {
  const s = { done: 0, fetched: 0, linked: 0, errors: 0, run_id: null, ...state };
  if (!s.run_id) s.run_id = await history({ name: "detaljer", started_at: new Date(clock()).toISOString() });
  const out = await step({ max: Math.min(DETAIL_PER_STEP, perNight - s.done) });
  s.done += out.checked;
  s.fetched += out.fetched;
  s.linked += out.linked;
  s.errors += out.errors;
  if (out.more && s.done < perNight && !(out.errors > out.checked / 2)) {
    await next(s);
    return s;
  }
  if (s.run_id) {
    await history({
      id: s.run_id,
      finished_at: new Date(clock()).toISOString(),
      status: s.errors ? `Klar, ${s.errors} fel` : "Klar",
      summary: `${s.fetched} annonsdetaljer hämtade · ${s.linked} med modellnummer${out.more ? " · fler kvar till nästa natt" : " · alla hämtade"}`,
    });
  }
  return s;
}
