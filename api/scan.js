// POST /api/scan  { images: [dataURL, …] (1–4 vinklar), buyPrice?: number, settings?: {...} }
// Tre steg: Googles bildsök → identifiering (ser bilderna) → prissökning (bara text).
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
import { GEMINI_MODEL, geminiArticle, geminiConfigured, geminiIdentify, geminiText } from "../lib/gemini.js";
import { mockGemini, mockIdentify, mockPrice, mockVision } from "../lib/mock.js";
import { VISION_USD_PER_IMAGE } from "../lib/models.js";
import { dropUnverifiedArticle, marketUrls, searchTerms } from "../lib/market.js";
import { mergeSettings } from "../lib/settings.js";
import { callAppsScript } from "../lib/storage.js";
import { visionConfigured, visionText, webDetect } from "../lib/vision.js";

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
          : (MOCK ? mockGemini() : geminiIdentify(images))
              .then((g) => {
                steps.push({ step: "Gemini", model: GEMINI_MODEL, tokens_in: g.tokensIn, tokens_out: g.tokensOut, searches: g.queries.length, usd: g.usd });
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
        const id = await (MOCK ? mockIdentify : identify)(images, hints, settings.models.identify);
        steps.push(stepCost("Identifiering", id));
        send({ type: "prelim", item: id.raw.item ?? {} });

        // 3. Prissökning – färdiga söksidor på artikelnummer/sökord
        dropUnverifiedArticle(id.raw, evidence);
        const urls = marketUrls(searchTerms(id.raw, evidence));
        send({ type: "status", text: "Hämtar sålda objekt…" });
        const price = await (MOCK ? mockPrice : priceSearch)(
          { identification: id.raw, vision: hints, urls, buyPrice, settings },
          settings.models.search,
          (text) => send({ type: "status", text }),
        );
        steps.push(stepCost("Prissök", price));

        const result = finalizeResult(
          { ...price.raw, item: id.raw.item, evidence: id.raw.evidence, candidates: id.raw.candidates },
          { buyPrice, settings },
        );
        result.search_urls = urls;
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

        const totals = emptyUsage();
        for (const s of steps) for (const u of s.usages ?? []) addUsage(totals, u);
        const usd = steps.reduce((sum, s) => sum + s.usd, 0);
        const cost = {
          usd: round(usd, 4),
          sek: round(usd * settings.fx.USD, 2),
          ...totals,
          steps: steps.map(({ usages, ...s }) => ({ ...s, usd: round(s.usd, 4), sek: round(s.usd * settings.fx.USD, 2) })),
        };
        const model = `ID ${id.model} · Sök ${price.model}${vision ? " · Vision" : ""}${gemini ? ` · ${GEMINI_MODEL}` : ""}`;
        const durationMs = Date.now() - started;
        send({ type: "result", scan_id: scanId, result, cost, model, images: images.length, duration_ms: durationMs });

        // Logga alltid skanningen, så att inget går förlorat. (Huvudbilden sparas i Drive.)
        const logged = await callAppsScript("logScan", {
          scan_id: scanId,
          image: dataUrls[0],
          result: { ...result, cost_steps: cost.steps },
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
  const status = err?.status;
  if (status === 401) return "Fel API-nyckel på servern (ANTHROPIC_API_KEY).";
  if (status === 429) return "För många anrop just nu – vänta en stund och försök igen.";
  if (status === 529 || status >= 500) return "Claude är överbelastat just nu – försök igen.";
  return err?.message || "Något gick fel.";
}
