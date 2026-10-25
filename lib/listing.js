// Annonsläget: berikar en fotad annons (1–3 bilder, första = huvudbild) med
// identifiering, priser och färdig annonstext. Körs av kön i Apps Script, så
// appen kan vara stängd under tiden.
import { readFileSync } from "node:fs";
import { finalizeResult } from "./economics.js";
import { ask } from "./gemini.js";
import { LENS_USD, lensConfigured, lensListings, lensRetail, lensSearch, lensText } from "./lens.js";
import { mergeSettings } from "./settings.js";
import { geminiScan, toPriceRaw, verifyArticle } from "./simple.js";
import { findOnTradera, mergeListings, traderaConfigured } from "./tradera.js";

export const LISTING_PROMPT = readFileSync(new URL("../prompts/tradera-annons.md", import.meta.url), "utf8");
export const BACKGROUND_LINE = "Kommer från rökfritt och djurfritt hem.";
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 7000;

// "från min egen samling", "ur vår samling", "privat samling" …
const FORBIDDEN = /\b(min|mitt|mina|vår|vårt|våra|egen|egna|privat|privata)\s+(egen\s+|egna\s+)?samling(ar|en)?\b/i;

// Tradera är standard. Vinted bara för kläder, skor och väskor.
const VINTED = /kläd|klänning|tröj|jacka|kappa|byxor|jeans|kjol|skjorta|blus|t-shirt|linne|kavaj|kostym|underkläd|strump|mössa|halsduk|vantar|handskar|sko|skor|känga|kängor|stövl|sandal|sneaker|väska|handväska|ryggsäck|plånbok/i;
export function channelFor(item) {
  const text = [item?.category, item?.name, item?.model].filter(Boolean).join(" ");
  return VINTED.test(text) ? "Vinted" : "Tradera";
}

// Rubrik och beskrivning kontrolleras av servern oavsett vad AI:n skrev:
// förbjudna formuleringar bort, bakgrundsraden exakt sist, längdgränser.
export function checkListingText({ title, description }) {
  const fixes = [];
  let t = String(title ?? "")
    .replace(/[!\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > TITLE_MAX) {
    t = t.slice(0, TITLE_MAX + 1).replace(/\s+\S*$/, "").trim() || t.slice(0, TITLE_MAX);
    fixes.push("Rubriken kortades till 80 tecken.");
  }

  const lines = String(description ?? "").replace(/\r/g, "").split("\n");
  const kept = [];
  for (const line of lines) {
    if (line.trim() === BACKGROUND_LINE || /rökfritt.*djurfritt|djurfritt.*rökfritt/i.test(line)) continue;
    if (FORBIDDEN.test(line)) {
      // Ta bort meningen, inte hela stycket.
      const cleaned = line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !FORBIDDEN.test(sentence))
        .join(" ")
        .trim();
      fixes.push("En formulering om egen samling togs bort.");
      if (cleaned) kept.push(cleaned);
      continue;
    }
    kept.push(line.trimEnd());
  }
  let body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const max = DESCRIPTION_MAX - BACKGROUND_LINE.length - 2;
  if (body.length > max) {
    body = body.slice(0, max).trim();
    fixes.push("Beskrivningen kortades.");
  }
  return { title: t, description: `${body}\n\n${BACKGROUND_LINE}`.trim(), fixes };
}

// Modellnummer att välja bland: AI:ns förslag, dess kandidater och nummer som
// återkommer i Lens-träffarna. Inget räknas som bekräftat förrän du trycker.
export function candidateNumbers({ article, candidates = [], lensNumbers = [] }) {
  const out = [];
  const add = (number, name, source) => {
    const n = String(number ?? "").trim();
    if (n && !out.some((c) => c.number === n)) out.push({ number: n, name: String(name ?? ""), source });
  };
  if (article?.number) add(article.number, "", article.source);
  for (const c of candidates) add(c?.article_number, c?.name, "Gemini");
  for (const n of lensNumbers) add(n.number, "", `Google Lens (${n.pages} träffar)`);
  return out.slice(0, 5);
}

function textPrompt({ item, article, note, marketNote }) {
  const facts = {
    namn: item.name,
    märke: item.brand,
    modell: item.model,
    artikelnummer: article?.verified ? article.number : "",
    kategori: item.category,
    ålder: item.age,
    skick_enligt_bilderna: item.condition,
    efterfrågan: marketNote,
  };
  return `${LISTING_PROMPT}

Identifiering:
${JSON.stringify(facts, null, 2)}
${note ? `\nSäljarens anteckning (går före det du ser): "${note}"` : ""}

Skriv annonsen.`;
}

// Hela berikningen för en annons. confirmed = modellnummer som du tryckt på i appen.
export async function researchListing({ images, note = "", confirmed = "", settings: input }, deps = {}) {
  const settings = mergeSettings(input);
  const steps = [];
  const flags = [];
  const fullNote = confirmed ? [note, `Modellnummer (bekräftat av säljaren): ${confirmed}`].filter(Boolean).join("\n") : note;

  // 1. Google Lens på huvudbilden.
  let lens = null;
  if (deps.lens || (settings.lens && lensConfigured())) {
    try {
      const l = await (deps.lens ?? lensSearch)(images[0], settings.fx);
      lens = l.summary;
      steps.push({ step: "Google Lens", usd: LENS_USD });
    } catch (err) {
      flags.push(`Google Lens misslyckades (${err.message}).`);
    }
  }
  const lensHints = lens ? lensText(lens) : "";

  // 2. Gemini identifierar utifrån bilderna och Lens-träffarna.
  const g = await (deps.gemini ?? geminiScan)({ images, hints: lensHints, note: fullNote, buyPrice: 0, settings, lens: Boolean(lens) });
  steps.push({ step: "Gemini", usd: g.usd });
  const priceRaw = toPriceRaw(g.raw, lens ? lensListings(lens) : null);
  const article = verifyArticle({ article: confirmed || g.raw?.item?.article_number, lensHints, note: fullNote });
  if (priceRaw.item) priceRaw.item.article_number = article?.verified ? article.number : "";

  // 3. Tradera: aktiva annonser och Lens-träffarnas Tradera-priser.
  let tradera = null;
  if (deps.tradera || (settings.tradera && traderaConfigured())) {
    try {
      tradera = await (deps.tradera ?? findOnTradera)({ item: priceRaw.item, article, lens });
      priceRaw.sources = mergeListings(tradera.listings, priceRaw.sources);
    } catch (err) {
      flags.push(`Tradera-sökningen misslyckades (${err.message}).`);
    }
  }

  const result = finalizeResult(priceRaw, { buyPrice: 0, settings, mode: "listings" });

  // 4. Annonstext med bilderna, utan sökning.
  const written = await (deps.write ?? ((imgs, prompt) => ask(imgs, prompt, undefined, { search: false, temperature: 0.2 })))(
    images,
    textPrompt({ item: result.item, article, note, marketNote: result.market_note }),
  );
  steps.push({ step: "Annonstext", usd: written.usd ?? 0 });
  const text = checkListingText({ title: written.raw?.title, description: written.raw?.description });

  const usd = steps.reduce((sum, s) => sum + (s.usd ?? 0), 0);
  return {
    item: result.item,
    article,
    confirmed: confirmed || "",
    candidates: candidateNumbers({ article, candidates: g.raw?.candidates, lensNumbers: lens?.numbers }),
    price: result.economics.list_price,
    list_basis: result.economics.list_basis,
    for_sale: result.for_sale,
    retail: lens ? lensRetail(lens) : null,
    sources: result.sources.slice(0, 8),
    channel: channelFor(result.item),
    title: text.title,
    description: text.description,
    fixes: text.fixes,
    flags: [...result.flags, ...flags],
    tradera_queries: tradera?.queries ?? [],
    cost: { usd: Number(usd.toFixed(4)), sek: Number((usd * settings.fx.USD).toFixed(2)) },
  };
}
