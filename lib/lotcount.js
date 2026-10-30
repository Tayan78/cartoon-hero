// Bildräkning: partier utan antal i rubriken ("Schleich djur paket") räknas från
// annonsens bilder med Gemini. Resultatet sparas i fliken "Bildräkning" så att
// varje annons bara räknas en gång. Värderingen använder det lägsta antalet.
import { ask } from "./gemini.js";
import { callAppsScript, storageConfigured } from "./storage.js";

export const COUNT_HEADERS = ["Annons-ID", "Rubrik", "Min", "Max", "Bäst", "Säkerhet", "Anteckning", "Bilder", "Kostnad USD", "Räknad"];
const SHEET = { sheet: "Bildräkning", headers: COUNT_HEADERS };
export const COUNT_IMAGES = 4; // bilder per annons till modellen
export const COUNT_MAX = 8; // nya räkningar per hämtning (resten nästa gång)

const PROMPT = `Bilderna kommer från EN Tradera-annons som säljer ett parti leksaksfigurer (oftast Schleich-djur).
Räkna hur många separata djur-/figurer partiet innehåller.

Regler:
- Samma figurer syns ofta på flera bilder (översikt + närbilder). Räkna INTE samma figur två gånger – utgå från den bild som visar flest figurer och lägg bara till figurer som tydligt saknas där.
- Räkna inte tillbehör: staket, hinder, sadlar, träns, foder, byggnader, stall, vagnar, kartonger.
- Räkna ryttare/människor bara om de är egna figurer.
- Är figurer dolda eller staplade: ge ett intervall.

Svara ENDAST med JSON:
{"min": <lägsta troliga antal>, "max": <högsta troliga antal>, "best": <bästa gissning>, "confidence": "high" | "medium" | "low", "note": "<kort, svenska: vad du såg, t.ex. 'ca 15 hästar och 5 föl, 2 bilder visar samma figurer'>"}`;

// Bildadresserna i Traderas annonsdetalj (GET /v4/items/{id}).
export function imagesOf(item, max = COUNT_IMAGES) {
  const plain = item?.imageLinks ?? [];
  const detailed = (item?.detailedImageLinks ?? []).filter((l) => !/thumb|small|mini/i.test(l?.format ?? "")).map((l) => l?.url);
  return [...new Set([...plain, ...detailed].filter((u) => typeof u === "string" && /^https?:\/\//.test(u)))].slice(0, max);
}

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

// Modellens svar → { min, max, best, confidence, note }, eller null om det inte går att lita på.
export function parseCount(raw) {
  let min = int(raw?.min);
  let max = int(raw?.max);
  let best = int(raw?.best);
  if (best == null) best = min ?? max;
  if (min == null) min = best;
  if (max == null) max = best;
  if ([min, max, best].some((n) => n == null)) return null;
  [min, max] = [Math.min(min, max), Math.max(min, max)];
  best = Math.min(Math.max(best, min), max);
  if (min < 2 || max > 300) return null;
  const confidence = ["high", "medium", "low"].includes(raw?.confidence) ? raw.confidence : "low";
  return { min, max, best, confidence, note: String(raw?.note ?? "").slice(0, 300) };
}

async function fetchImageData(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Bild ${res.status}`);
  const mediaType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];
  return { mediaType, data: Buffer.from(await res.arrayBuffer()).toString("base64") };
}

export async function countFromImages(urls, { askModel = ask, fetchImage = fetchImageData } = {}) {
  const images = (await Promise.all(urls.map((u) => fetchImage(u).catch(() => null)))).filter(Boolean);
  if (!images.length) return null;
  const r = await askModel(images, PROMPT, undefined, { search: false, temperature: 0 });
  const parsed = parseCount(r.raw);
  return parsed && { ...parsed, images: images.length, usd: r.usd ?? 0 };
}

const fromRow = (r) =>
  parseCount({ min: r.Min, max: r.Max, best: r["Bäst"], confidence: r["Säkerhet"], note: r.Anteckning });

async function readCache(store) {
  try {
    if (store === callAppsScript && !storageConfigured()) return new Map();
    const res = await store("sheetRead", SHEET);
    return new Map((res?.ok ? res.rows : []).map((r) => [String(r["Annons-ID"]), fromRow(r)]).filter(([, c]) => c));
  } catch {
    return new Map();
  }
}

// Sätter antal på partier som saknar det men har bilder (lot.images). Antalet blir
// det lägsta troliga; hela uppskattningen följer med som count_estimate.
export async function countLots(lots, { store = callAppsScript, count = countFromImages, max = COUNT_MAX, now = Date.now() } = {}) {
  const todo = lots.filter((l) => !l.ended && !l.count && l.images?.length);
  if (!todo.length) return { lots, counted: 0, pending: 0, usd: 0 };
  const cache = await readCache(store);
  const fresh = todo.filter((l) => !cache.has(String(l.id))).slice(0, max);
  const results = new Map();
  let usd = 0;
  for (let i = 0; i < fresh.length; i += 4) {
    await Promise.all(
      fresh.slice(i, i + 4).map(async (l) => {
        const c = await count(l.images).catch(() => null);
        if (!c) return;
        usd += c.usd ?? 0;
        results.set(String(l.id), c);
      }),
    );
  }
  if (results.size) {
    const rows = fresh
      .filter((l) => results.has(String(l.id)))
      .map((l) => {
        const c = results.get(String(l.id));
        return {
          "Annons-ID": String(l.id), Rubrik: l.title, Min: c.min, Max: c.max, "Bäst": c.best, "Säkerhet": c.confidence,
          Anteckning: c.note, Bilder: c.images, "Kostnad USD": Math.round((c.usd ?? 0) * 10000) / 10000, Räknad: new Date(now).toISOString(),
        };
      });
    await store("sheetUpsert", { ...SHEET, key: "Annons-ID", rows }).catch(() => {});
  }
  const estimateOf = (l) => results.get(String(l.id)) ?? cache.get(String(l.id));
  const out = lots.map((l) => {
    const c = !l.ended && !l.count && estimateOf(l);
    if (!c) return l;
    const { images, usd: _u, ...estimate } = c;
    return { ...l, count: c.min, count_estimate: estimate };
  });
  const pending = todo.filter((l) => !estimateOf(l)).length;
  return { lots: out, counted: results.size, pending, usd: Math.round(usd * 10000) / 10000 };
}
