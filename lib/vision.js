// Google Cloud Vision – Web Detection ("Google Lens"-tekniken).
// Hittar sidor med samma eller liknande bild och Googles bästa gissning på vad
// föremålet är. Ger inga priser; resultatet används som ledtrådar till modellerna.

const ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";

export const visionConfigured = () => Boolean(process.env.GOOGLE_VISION_API_KEY);

// images: [{ mediaType, data }] → sammanfattning, eller null om inget hittades.
export async function webDetect(images) {
  const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(process.env.GOOGLE_VISION_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: images.map((img) => ({
        image: { content: img.data },
        features: [{ type: "WEB_DETECTION", maxResults: 10 }],
        imageContext: { webDetectionParams: { includeGeoResults: true } },
      })),
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Vision svarade ${res.status}`);
  return summarize(data.responses ?? []);
}

// Slår ihop svaren för alla bilder och behåller det som är användbart som ledtråd.
export function summarize(responses) {
  const guesses = new Set();
  const entities = new Map();
  const pages = new Map();

  for (const r of responses) {
    const web = r.webDetection;
    if (!web) continue;
    for (const g of web.bestGuessLabels ?? []) if (g.label) guesses.add(g.label);
    for (const e of web.webEntities ?? []) {
      if (!e.description) continue;
      const prev = entities.get(e.description) ?? 0;
      entities.set(e.description, Math.max(prev, e.score ?? 0));
    }
    for (const p of web.pagesWithMatchingImages ?? []) {
      if (!p.url || pages.has(p.url)) continue;
      const full = (p.fullMatchingImages ?? []).length > 0;
      pages.set(p.url, { title: stripTags(p.pageTitle ?? ""), url: p.url, exact: full });
    }
  }

  const summary = {
    best_guesses: [...guesses].slice(0, 5),
    entities: [...entities]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([description, score]) => ({ description, score: Math.round(score * 100) / 100 })),
    // Exakta bildträffar först.
    pages: [...pages.values()].sort((a, b) => Number(b.exact) - Number(a.exact)).slice(0, 10),
  };
  const empty = !summary.best_guesses.length && !summary.entities.length && !summary.pages.length;
  return empty ? null : summary;
}

const stripTags = (s) => s.replace(/<[^>]+>/g, "").trim();

// Kort text till modellerna.
export function visionText(summary) {
  if (!summary) return "Bildsök: inga träffar.";
  const lines = ["Ledtrådar från Googles bildsök (kan vara fel – bedöm själv mot bilderna):"];
  if (summary.best_guesses.length) lines.push(`- Bästa gissning: ${summary.best_guesses.join("; ")}`);
  if (summary.entities.length) {
    lines.push(`- Nyckelord: ${summary.entities.map((e) => `${e.description} (${e.score})`).join(", ")}`);
  }
  if (summary.pages.length) {
    lines.push("- Sidor med samma/liknande bild:");
    for (const p of summary.pages) lines.push(`  - ${p.exact ? "[exakt] " : ""}${p.title || "(ingen titel)"} – ${p.url}`);
  }
  return lines.join("\n");
}
