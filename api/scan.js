// POST /api/scan  { images: [dataURL, …] (1–4 vinklar), buyPrice?: number, note?: string, settings?: {...} }
// Enkelt läge (standard): Googles bildsök → Gemini (identifiering + annonser till salu i Sverige).
// Avancerat läge: bildsök + Gemini → identifiering med Claude → prissökning (bara text).
// Svarar med NDJSON (en JSON per rad) så att appen kan visa delresultat:
//   {"type":"status","text":"…"}      – vad som händer just nu
//   {"type":"prelim","item":{…}}      – identifieringen, innan priserna är klara
//   {"type":"result",…}               – färdigt resultatkort
//   {"type":"logged",…}               – raden är sparad i Google Sheet
//   {"type":"error","error":"…"}
import { randomBytes } from "node:crypto";
import { identify, priceSearch } from "../lib/claude.js";
import { addUsage, costUsd, emptyUsage, finalizeResult } from "../lib/economics.js";
import { checkAuth, json, parseDataUrl } from "../lib/http.js";
import { geminiArticle, geminiConfigured, geminiSentence, geminiIdentify, geminiPriceSearch, geminiText } from "../lib/gemini.js";
import { DEFAULT_SEARCH_MODEL } from "../lib/models.js";
import { mockGemini, mockGeminiPrice, mockIdentify, mockLens, mockPrice, mockSentence, mockSimple, mockTradera, mockVision, mockVisionRaw } from "../lib/mock.js";
import { checkExplanation, explainPrompt } from "../lib/decision.js";
import { debugData, geminiScan, simpleLinks, toPriceRaw, verifyArticle } from "../lib/simple.js";
import { mergeListings, traderaConfigured, traderaQuery, traderaSearch } from "../lib/tradera.js";
import { LENS_USD, lensConfigured, lensListings, lensRetail, lensSearch, lensText } from "../lib/lens.js";
import { VISION_USD_PER_IMAGE } from "../lib/models.js";
import { dropUnverifiedArticle, formatArticle, marketUrls, pickArticle, searchTerms } from "../lib/market.js";
import { mergeSettings } from "../lib/settings.js";
import { callAppsScript } from "../lib/storage.js";
import { visionConfigured, visionText, webDetect, webDetectRaw } from "../lib/vision.js";

const MOCK = process.env.MOCK === "1";
const MAX_IMAGES = 4;

function newScanId() {
  // "2026-10-24 16:36:05" i svensk tid → "20261024-163605"
  const stamp = new Date()
    .toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })
    .replace(/[-:]/g, "")
    .replace(" ", "-");
  return `S${stamp}-${randomBytes(2).toString("hex")}`;
}

const round = (n, d) => Number(n.toFixed(d));

export async function POST(request) {
  const denied = checkAuth(request);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ogiltig förfrågan" }, 400);
  }
  const dataUrls = (Array.isArray(body.images) ? body.images : [body.image]).filter(Boolean).slice(0, MAX_IMAGES);
  const images = dataUrls.map(parseDataUrl);
  if (!images.length || images.some((img) => !img)) return json({ error: "Bild saknas eller har fel format" }, 400);
  const buyPrice = Math.max(0, Math.round(Number(body.buyPrice) || 0));
  // Egna uppgifter om föremålet (märke, modell, storlek …), valfritt.
  const note = String(body.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const settings = mergeSettings(body.settings);
  const scanId = newScanId();
  const started = Date.now();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      const steps = [];
      const flags = [];

      try {
        const simple = settings.mode === "simple" && (MOCK || geminiConfigured());
        if (settings.mode === "simple" && !simple) flags.push("Gemini är inte konfigurerat – avancerat läge användes.");
        const ctx = { images, note, buyPrice, settings, send, steps, flags, scanId };
        const { result, modelLabel: model } = await (simple ? runSimple(ctx) : runAdvanced(ctx));
        await explain(result, steps, send);

        const totals = emptyUsage();
        for (const s of steps) {
          if (s.usages) for (const u of s.usages) addUsage(totals, u);
          // Gemini- och Lens-steg har egna räknare i stället för Claude-usage.
          else if (s.model?.startsWith("gemini") || s.model?.startsWith("serpapi") || s.model?.startsWith("tradera")) {
            totals.input_tokens += s.tokens_in ?? 0;
            totals.output_tokens += s.tokens_out ?? 0;
            totals.web_searches += s.searches ?? 0;
          }
        }
        const usd = steps.reduce((sum, s) => sum + s.usd, 0);
        const cost = {
          usd: round(usd, 4),
          sek: round(usd * settings.fx.USD, 2),
          ...totals,
          steps: steps.map(({ usages, ...s }) => ({ ...s, usd: round(s.usd, 4), sek: round(s.usd * settings.fx.USD, 2) })),
        };
        const durationMs = Date.now() - started;
        send({ type: "result", scan_id: scanId, result, cost, model, images: images.length, duration_ms: durationMs });

        // Logga alltid skanningen, så att inget går förlorat. (Huvudbilden sparas i Drive.)
        const logged = await callAppsScript("logScan", {
          scan_id: scanId,
          image: dataUrls[0],
          // Modellnumret (med källa) i Sheets kolumn Artikelnr, även när det är obekräftat.
          // Rådata stannar i appen (för stor för en cell i Sheet).
          result: { ...result, debug: undefined, item: { ...result.item, article_number: formatArticle(result.article) }, cost_steps: cost.steps },
          cost,
          model,
          duration_ms: durationMs,
        }).catch((err) => ({ ok: false, error: err.message }));
        send({ type: "logged", ok: Boolean(logged.ok), image_url: logged.image_url ?? "", error: logged.error });
      } catch (err) {
        console.error("scan misslyckades:", err);
        send({ type: "error", error: friendlyError(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Avancerat läge: Vision + Gemini (identifiering) → Claude granskar → prissökning
// med Claude eller Gemini, inklusive sålda priser.
async function runAdvanced({ images, note, buyPrice, settings, send, steps, flags, scanId }) {
  // 1. Bildsök (Cloud Vision) och Gemini med Google-sökning, parallellt
  const useVision = settings.vision && (MOCK || visionConfigured());
  const useGemini = settings.gemini && (MOCK || geminiConfigured());
  send({ type: "status", text: useGemini ? "Söker på Google…" : useVision ? "Bildsök…" : "Identifierar…", scan_id: scanId });

  const visionJob = !useVision
    ? null
    : (MOCK ? mockVision() : webDetect(images))
        .then((v) => {
          steps.push({ step: "Bildsök", model: "google-vision", images: images.length, usd: images.length * VISION_USD_PER_IMAGE });
          return v;
        })
        .catch((err) => {
          console.warn("Vision misslyckades:", err.message);
          flags.push(`Bildsöket misslyckades (${err.message}).`);
          return null;
        });
  const geminiJob = !useGemini
    ? null
    : (MOCK ? mockGemini() : geminiIdentify(images, note))
        .then((g) => {
          steps.push({ step: "Gemini", model: g.model, tokens_in: g.tokensIn, tokens_out: g.tokensOut, searches: g.queries.length, usd: g.usd });
          if (!g.grounded) flags.push("Gemini sökte inte på Google trots två försök – dess förslag användes bara som ledtråd.");
          const article = geminiArticle(g);
          if (g.raw.name) send({ type: "prelim", item: { name: g.raw.name, brand: g.raw.brand, model: article || g.raw.model } });
          return g;
        })
        .catch((err) => {
          console.warn("Gemini misslyckades:", err.message);
          flags.push(`Gemini-sökningen misslyckades (${err.message}).`);
          return null;
        });
  const [vision, gemini] = await Promise.all([visionJob, geminiJob]);

  // Ledtrådar till modellerna, och det som räknas som belagt för artikelnummer.
  const hints = [useVision ? visionText(vision) : "Bildsök: används inte.", geminiText(gemini)].filter(Boolean).join("\n\n");
  const evidence = [useVision ? visionText(vision) : "", geminiArticle(gemini)].join("\n");

  // 2. Identifiering
  send({ type: "status", text: images.length > 1 ? `Identifierar (${images.length} bilder)…` : "Identifierar…", scan_id: scanId });
  const id = await (MOCK ? mockIdentify : identify)(images, hints, settings.models.identify, note);
  steps.push(stepCost("Identifiering", id));
  send({ type: "prelim", item: id.raw.item ?? {} });

  // 3. Prissökning – färdiga söksidor på artikelnummer/sökord
  dropUnverifiedArticle(id.raw, evidence);
  const urls = marketUrls(searchTerms(id.raw, evidence));
  const priceInput = { identification: id.raw, vision: hints, urls, buyPrice, settings, note };
  const onStatus = (text) => send({ type: "status", text });
  let searchModel = settings.models.search;
  if (searchModel === "gemini" && !(MOCK || geminiConfigured())) {
    flags.push("Gemini är inte konfigurerat – prissökningen gjordes med Claude.");
    searchModel = DEFAULT_SEARCH_MODEL;
  }
  let price;
  if (searchModel === "gemini") {
    // Gemini med Google-sökning
    const g = await (MOCK ? mockGeminiPrice : geminiPriceSearch)(priceInput, onStatus);
    price = { raw: g.raw, model: g.model, googleSources: g.sources };
    steps.push({ step: "Prissök", model: g.model, tokens_in: g.tokensIn, tokens_out: g.tokensOut, searches: g.queries.length, usd: g.usd });
    if (!g.grounded) flags.push("Gemini sökte inte på Google för priset – siffrorna är osäkra.");
  } else {
    send({ type: "status", text: "Hämtar sålda objekt…" });
    price = await (MOCK ? mockPrice : priceSearch)(priceInput, searchModel, onStatus);
    steps.push(stepCost("Prissök", price));
  }

  const result = finalizeResult(
    { ...price.raw, item: id.raw.item, evidence: id.raw.evidence, candidates: id.raw.candidates },
    { buyPrice, settings },
  );
  result.search_urls = urls;
  result.note = note;
  if (price.googleSources?.length) result.price_google_sources = price.googleSources;
  result.article = pickArticle({ item: id.raw.item, gemini, vision });
  result.flags.push(...flags);
  if (vision) result.vision = vision;
  if (gemini) {
    result.gemini = {
      name: gemini.raw.name ?? "",
      article_number: geminiArticle(gemini),
      confidence: gemini.raw.confidence ?? "",
      sources: gemini.sources,
    };
  }
  return {
    result,
    modelLabel: `ID ${id.model} · Sök ${price.model}${vision ? " · Vision" : ""}${gemini ? ` · ${gemini.model}` : ""}`,
  };
}

// Enkelt läge: Vision → ett Gemini-anrop (identifiering + annonser till salu i
// Sverige). Inga sålda priser; utpris = lägsta Tradera/eBay-annons.
async function runSimple({ images, note, buyPrice, settings, send, steps, flags, scanId }) {
  // 1. Google Lens (SerpApi) – annars Cloud Vision som reserv.
  const useLens = settings.lens && (MOCK || lensConfigured());
  let useVision = !useLens && settings.vision && (MOCK || visionConfigured());
  let lens = null;
  let lensRaw = null;
  let vision = null;
  let visionRaw = null;
  if (useLens) {
    send({ type: "status", text: "Google Lens…", scan_id: scanId });
    try {
      const l = await (MOCK ? mockLens(settings.fx) : lensSearch(images[0], settings.fx));
      lens = l.summary;
      lensRaw = l.raw;
      steps.push({ step: "Google Lens", model: "serpapi-google-lens", searches: 1, usd: LENS_USD });
    } catch (err) {
      // T.ex. slut på månadens gratissökningar: bildsöket (Cloud Vision) tar över.
      useVision = settings.vision && (MOCK || visionConfigured());
      flags.push(`Google Lens misslyckades (${err.message})${useVision ? " – bildsöket användes i stället" : ""}.`);
    }
  }
  if (useVision) {
    send({ type: "status", text: "Bildsök…", scan_id: scanId });
    try {
      const v = await (MOCK ? mockVisionRaw() : webDetectRaw(images));
      vision = v.summary;
      visionRaw = v.raw;
      steps.push({ step: "Bildsök", model: "google-vision", images: images.length, usd: images.length * VISION_USD_PER_IMAGE });
    } catch (err) {
      flags.push(`Bildsöket misslyckades (${err.message}).`);
    }
  }
  const lensHints = lens ? lensText(lens) : "";
  const visionHints = useVision ? visionText(vision) : "";
  const hints = [lensHints, visionHints].filter(Boolean).join("\n\n");

  // 2. Gemini: identifiering (och annonser bara om Lens saknas).
  send({ type: "status", text: lens ? "Identifierar…" : "Söker på Google…", scan_id: scanId });
  const g = await (MOCK ? mockSimple : geminiScan)(
    { images, hints, note, buyPrice, settings, lens: Boolean(lens) },
    (text) => send({ type: "status", text }),
  );
  steps.push({ step: "Gemini", model: g.model, tokens_in: g.tokensIn, tokens_out: g.tokensOut, searches: g.queries.length, usd: g.usd });
  if (!g.grounded && !lens) flags.push("Gemini sökte inte på Google – svaret bygger på modellens minne och är osäkert.");

  const priceRaw = toPriceRaw(g.raw, lens ? lensListings(lens) : null);
  const article = verifyArticle({ article: g.raw?.item?.article_number, visionHints, lensHints, note });
  if (priceRaw.item) priceRaw.item.article_number = article?.verified ? article.number : "";
  send({ type: "prelim", item: priceRaw.item ?? {} });

  // 3. Traderas egna sökning: riktiga aktiva annonser (gratis, bara appnycklar).
  let tradera = null;
  if (settings.tradera && (MOCK || traderaConfigured())) {
    const q = traderaQuery({ item: priceRaw.item, article });
    send({ type: "status", text: "Söker på Tradera…" });
    try {
      tradera = await (MOCK ? mockTradera(q) : traderaSearch(q));
      priceRaw.sources = mergeListings(tradera.listings, priceRaw.sources);
      steps.push({ step: "Tradera", model: "tradera-api", searches: 0, usd: 0 });
      if (!tradera.listings.length) flags.push(`Inga aktiva Tradera-annonser för ${q.queries.map((x) => `"${x}"`).join(" eller ")}.`);
    } catch (err) {
      flags.push(`Tradera-sökningen misslyckades (${err.message}).`);
    }
  }

  const result = finalizeResult(priceRaw, { buyPrice, settings, mode: "listings" });
  result.article = article;
  result.note = note;
  result.flags.push(...flags);
  const brand = (result.item.brand ?? "").replace(/\(.*?\)/g, "").trim();
  result.search_urls = simpleLinks(article?.verified ? `${brand} ${article.number}`.trim() : result.item.name);
  if (g.sources?.length) result.price_google_sources = g.sources;
  if (vision) result.vision = vision;
  if (lens) {
    result.lens = { matches: lens.matches.length, priced: lens.priced.length, numbers: lens.numbers };
    result.retail = lensRetail(lens);
  }
  result.debug = debugData({ visionRaw, lensRaw, gemini: g });
  if (tradera) {
    result.tradera = { query: tradera.query, total: tradera.total, shown: tradera.listings.length, matched_number: tradera.matched_number };
    result.debug.tradera = { ...result.tradera, tried: tradera.tried, listings: tradera.listings };
  }
  return { result, modelLabel: `Enkelt · ${lens ? "Lens · " : ""}${g.model}${tradera ? " · Tradera" : ""}${vision ? " · Vision" : ""}` };
}

// Motiveringen: beslutet är redan fattat av servern. Gemini får beslutet och
// siffrorna och skriver en mening; en text som säger emot beslutet kastas och
// den regelstyrda motiveringen står kvar.
async function explain(result, steps, send) {
  result.reason_source = "regler";
  if (!(MOCK || geminiConfigured())) return;
  send({ type: "status", text: "Skriver motivering…" });
  try {
    const prompt = explainPrompt(result.decision, {
      name: result.item.name,
      listPrice: result.economics.list_price,
      marketNote: result.market_note,
    });
    const g = await (MOCK ? mockSentence : geminiSentence)(prompt);
    steps.push({ step: "Motivering", model: g.model, tokens_in: g.tokensIn, tokens_out: g.tokensOut, searches: 0, usd: g.usd });
    const text = checkExplanation(g.text, result.decision);
    if (text) {
      result.reason = text;
      result.reason_source = "ai";
    }
  } catch (err) {
    console.warn("Motiveringen misslyckades:", err.message);
  }
}

// Summerar token och kostnad för ett steg (ett eller flera API-anrop).
function stepCost(step, { usages, model }) {
  const usage = emptyUsage();
  for (const u of usages) addUsage(usage, u);
  return {
    step,
    model,
    usages,
    tokens_in: usage.input_tokens,
    tokens_out: usage.output_tokens,
    searches: usage.web_searches,
    fetches: usage.web_fetches,
    usd: costUsd(model, usage),
  };
}

function friendlyError(err) {
  if (err?.source === "gemini") return `Gemini: ${err.message}`;
  const status = err?.status;
  if (status === 401) return "Fel API-nyckel på servern (ANTHROPIC_API_KEY).";
  if (status === 429) return "För många anrop just nu – vänta en stund och försök igen.";
  if (status === 529 || status >= 500) return "Claude är överbelastat just nu – försök igen.";
  return err?.message || "Något gick fel.";
}
