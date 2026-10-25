// Enkelt läge: Cloud Vision → ett Gemini-anrop som identifierar föremålet och
// hittar annonser till salu just nu, med Google-sökning som i Sverige.
// Inga sålda priser söks; servern räknar utpris och netto från annonserna.
import { ask } from "./gemini.js";

export const SIMPLE_PROMPT = `Du hjälper en svensk reseller som står på en loppis. Du får 1–4 bilder på ett föremål, ibland säljarens egna uppgifter och ledtrådar från Googles bildsök.

Gör så här, och använd Google-sökning – svara aldrig ur minnet:

1. Identifiera föremålet så exakt som möjligt: tillverkare, modell/serie/mönster och artikel-/modellnummer. Bildsökets sidtitlar och nummer som återkommer i flera träffar är starka bevis. Ange bara ett artikelnummer som står på föremålet, i säljarens uppgifter, i bildsökets träffar eller i dina sökresultat – gissa aldrig. Bedöm synligt skick.

2. Sök som en köpare i Sverige: svenska sökord, svenska sajter och priser i kronor. Hitta annonser för SAMMA modell som är till salu just nu:
   - först Tradera och eBay (de väger tyngst),
   - sedan Blocket, Vinted, Facebook Marketplace, Sellpy och andra svenska begagnatsajter.
   Sök gärna på artikelnumret. Ta inte med sålda eller avslutade annonser, nya varor från butiker eller andra modeller. Räkna om utländska priser till SEK med växelkurserna i meddelandet.

3. Ge ett typiskt pris (price_sek: low, median, high) utifrån annonserna och en kort mening om efterfrågan (market_note: hur lättsåld/eftertraktad modellen är, om den är utgången o.d.). Ge INGET köpråd och ingen bedömning av om det är en bra affär – det räknar servern ut.

Svara ENDAST med JSON, ingen annan text:
{
  "item": {"name": "kort visningsnamn", "category": "", "brand": "", "model": "", "article_number": "", "article_number_source": "föremålet|bildsöket|google|", "age": "", "production_years": "", "listing_name": "", "condition": "", "confidence_id": "high|medium|low"},
  "candidates": [{"name": "", "article_number": ""}],
  "evidence": "en mening om vad identifieringen bygger på",
  "price_sek": {"low": 0, "median": 0, "high": 0, "confidence": "high|medium|low"},
  "listings": [{"title": "", "url": "", "platform": "Tradera|eBay|Blocket|Vinted|Facebook|Sellpy|Annan", "price": 0, "currency": "SEK|EUR|USD|GBP", "price_sek": 0}],
  "market_note": "",
  "best_platform": "Tradera|Vinted|Blocket|Annan"
}
production_years: åren modellen tillverkades, t.ex. "2003-2008", bara om det står i Lens-träffarna eller dina sökresultat (t.ex. samlarsajter) – annars tom. listing_name: kort annonsnamn på svenska utan märke och nummer; för djurfigurer ras + djurtyp, t.ex. "Tinker sto", "Knabstrupper föl", "Siberian Husky hund".
Max 12 annonser, Tradera/eBay först. Annonsens url ska vara annonsens egen adress som du sett i sökresultaten – hitta aldrig på adresser. Okända fält: tom sträng.`;

export function buildSimpleText({ imageCount, vision, note, buyPrice, settings, lens = false }) {
  const fx = Object.entries(settings.fx)
    .map(([cur, rate]) => `1 ${cur} = ${rate} SEK`)
    .join(", ");
  return [
    imageCount > 1 ? `${imageCount} bilder på samma föremål.` : "En bild.",
    note ? `Säljarens egna uppgifter (t.ex. från etiketten): "${note}"` : "",
    vision,
    `Växelkurser: ${fx}.`,
    lens
      ? "Annonser och priser hämtas separat från Google Lens-träffarna ovan: lämna listings tom och sök inte efter annonser. Fokusera på exakt identifiering (använd Lens-titlarna), skick, ett typiskt pris (price_sek) utifrån Lens-priserna och efterfrågan (market_note)."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Är artikelnumret belagt? Står det i säljarens text, i Google Lens-titlarna
// eller i bildsöket räknas det. Geminis källstöd (groundingSupports) räcker inte:
// det visar att en mening har stöd i någon källa, inte att numret stämmer
// (testet med Schleich-hästen gav 13803 med "stöd" när rätt nummer var 13695).
export function verifyArticle({ article, visionHints = "", lensHints = "", note = "" }) {
  const n = String(article ?? "").trim();
  if (!n) return null;
  const has = (text) => String(text ?? "").toUpperCase().includes(n.toUpperCase());
  if (has(note)) return { number: n, source: "din info", verified: true };
  if (has(lensHints)) return { number: n, source: "Google Lens", verified: true };
  if (has(visionHints)) return { number: n, source: "bildsök", verified: true };
  return { number: n, source: "Gemini", verified: false };
}

// Gör om Geminis svar till det format finalizeResult tar emot: annonserna blir
// källor med sold=false. Bara riktiga webbadresser behålls.
// Med Google Lens används bara Lens-träffarna som annonser (riktiga sidor);
// Geminis egna annonser tas inte med, eftersom de har visat sig vara påhittade.
export function toPriceRaw(raw, lensSources = null) {
  const listings = lensSources
    ? lensSources
    : (Array.isArray(raw?.listings) ? raw.listings : [])
        .filter((l) => typeof l?.url === "string" && /^https?:\/\//.test(l.url))
        .map((l) => ({ ...l, sold: false, via: "google" }));
  return {
    price_sek: { ...(raw?.price_sek ?? {}), comparables: 0 },
    sources: listings,
    market_note: raw?.market_note,
    best_platform: raw?.best_platform,
    item: raw?.item,
    candidates: raw?.candidates,
    evidence: raw?.evidence,
  };
}

// Ett anrop till Gemini (temperatur 0 för stabilare svar), plus ett nytt försök
// om Gemini svarade utan att söka.
export async function geminiScan({ images, hints, note, buyPrice, settings, lens = false }, onStatus = () => {}) {
  const prompt = `${SIMPLE_PROMPT}\n\n${buildSimpleText({ imageCount: images.length, vision: hints, note, buyPrice, settings, lens })}`;
  const opts = { swedish: true, temperature: 0 };
  const first = await ask(images, prompt, undefined, opts);
  // Med Lens ska Gemini inte söka själv, så ett svar utan sökning är väntat.
  if (first.grounded || lens) return { ...first, attempts: 1 };
  onStatus("Söker på Google (2)…");
  const retry = `Du svarade utan att söka. Gör nu Google-sökningar (som i Sverige) innan du svarar.\n\n${prompt}`;
  const second = await ask(images, retry, [first.model], opts).catch(() => null);
  const chosen = second?.grounded ? second : first;
  const total = (key) => first[key] + (second?.[key] ?? 0);
  return {
    ...chosen,
    tokensIn: total("tokensIn"),
    tokensOut: total("tokensOut"),
    usd: total("usd"),
    queries: [...first.queries, ...(second?.queries ?? [])],
    attempts: second ? 2 : 1,
  };
}

// Länkar på kortet för egen kontroll: annonser till salu på de största sajterna.
export function simpleLinks(term) {
  if (!term) return [];
  const q = encodeURIComponent(term);
  return [
    { label: "Tradera – till salu", url: `https://www.tradera.com/search?q=${q}` },
    { label: "eBay – till salu", url: `https://www.ebay.com/sch/i.html?_nkw=${q}` },
    { label: "Blocket", url: `https://www.blocket.se/annonser/hela_sverige?q=${q}` },
    { label: "Vinted", url: `https://www.vinted.se/catalog?search_text=${q}` },
  ];
}

// Rådata till "Visa rådata": Googles svar utan de största fälten.
export function debugData({ visionRaw, lensRaw, gemini }) {
  const trimVision = (visionRaw ?? []).map((r) => {
    const w = { ...(r.webDetection ?? {}) };
    if (w.visuallySimilarImages) w.visuallySimilarImages = w.visuallySimilarImages.slice(0, 5);
    if (w.partialMatchingImages) w.partialMatchingImages = w.partialMatchingImages.slice(0, 5);
    return { webDetection: w, error: r.error };
  });
  const c = gemini?.response?.candidates?.[0] ?? {};
  const { searchEntryPoint, ...grounding } = c.groundingMetadata ?? {};
  const trimLens = lensRaw
    ? {
        search_metadata: lensRaw.search_metadata,
        search_parameters: { ...(lensRaw.search_parameters ?? {}), api_key: undefined },
        exact_matches: (lensRaw.exact_matches ?? []).slice(0, 10),
        visual_matches: (lensRaw.visual_matches ?? []).slice(0, 20),
        products: (lensRaw.products ?? []).slice(0, 10),
        related_content: (lensRaw.related_content ?? []).slice(0, 5),
      }
    : undefined;
  return {
    lens: trimLens,
    vision: trimVision,
    gemini: gemini
      ? {
          model: gemini.model,
          attempts: gemini.attempts,
          text: (c.content?.parts ?? []).map((p) => p.text ?? "").join(""),
          groundingMetadata: grounding,
          usageMetadata: gemini.response?.usageMetadata,
        }
      : null,
  };
}
