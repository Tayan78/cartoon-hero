// POST /api/scan  { image: dataURL, buyPrice?: number, settings?: {...} }
// Svarar med NDJSON (en JSON per rad) så att appen kan visa delresultat:
//   {"type":"status","text":"…"}      – vad som händer just nu
//   {"type":"prelim","item":{…}}      – snabb identifiering innan priserna är klara
//   {"type":"result",…}               – färdigt resultatkort
//   {"type":"logged",…}               – raden är sparad i Google Sheet
//   {"type":"error","error":"…"}
import { randomBytes } from "node:crypto";
import { MODEL, identify, scan } from "../lib/claude.js";
import { addUsage, costUsd, emptyUsage, finalizeResult } from "../lib/economics.js";
import { checkAuth, json, parseDataUrl } from "../lib/http.js";
import { mockIdentify, mockScan } from "../lib/mock.js";
import { mergeSettings } from "../lib/settings.js";
import { callAppsScript } from "../lib/storage.js";

const MOCK = process.env.MOCK === "1";

function newScanId() {
  // "2026-10-24 16:36:05" i svensk tid → "20261024-163605"
  const stamp = new Date()
    .toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })
    .replace(/[-:]/g, "")
    .replace(" ", "-");
  return `S${stamp}-${randomBytes(2).toString("hex")}`;
}

export async function POST(request) {
  const denied = checkAuth(request);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ogiltig förfrågan" }, 400);
  }
  const image = parseDataUrl(body.image);
  if (!image) return json({ error: "Bild saknas eller har fel format" }, 400);
  const buyPrice = Math.max(0, Math.round(Number(body.buyPrice) || 0));
  const settings = mergeSettings(body.settings);
  const scanId = newScanId();
  const started = Date.now();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      const usage = emptyUsage();
      let finished = false;

      send({ type: "status", text: "Identifierar…", scan_id: scanId });

      const prelim = (MOCK ? mockIdentify() : identify(image))
        .then((r) => {
          addUsage(usage, r.usage);
          if (!finished) send({ type: "prelim", item: r.item });
        })
        .catch((err) => console.warn("identify misslyckades:", err.message));

      try {
        const full = await (MOCK ? mockScan : scan)(image, { buyPrice, settings }, (text) => {
          if (!finished) send({ type: "status", text });
        });
        finished = true;
        for (const u of full.usages) addUsage(usage, u);
        await prelim;

        const result = finalizeResult(full.raw, { buyPrice, settings });
        const usd = costUsd(full.model === "mock" ? MODEL : full.model, usage);
        const cost = { usd: Number(usd.toFixed(4)), sek: Number((usd * settings.fx.USD).toFixed(2)), ...usage };
        const durationMs = Date.now() - started;
        send({ type: "result", scan_id: scanId, result, cost, model: full.model, duration_ms: durationMs });

        // Logga alltid skanningen, så att inget går förlorat.
        const logged = await callAppsScript("logScan", {
          scan_id: scanId,
          image: body.image,
          result,
          cost,
          model: full.model,
          duration_ms: durationMs,
        }).catch((err) => ({ ok: false, error: err.message }));
        send({ type: "logged", ok: Boolean(logged.ok), image_url: logged.image_url ?? "", error: logged.error });
      } catch (err) {
        finished = true;
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

function friendlyError(err) {
  const status = err?.status;
  if (status === 401) return "Fel API-nyckel på servern (ANTHROPIC_API_KEY).";
  if (status === 429) return "För många anrop just nu – vänta en stund och försök igen.";
  if (status === 529 || status >= 500) return "Claude är överbelastat just nu – försök igen.";
  return err?.message || "Något gick fel.";
}
