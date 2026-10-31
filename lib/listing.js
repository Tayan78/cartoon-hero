// Annonsläget: berikar en fotad annons (AI:n får 1–3 av bilderna, första = huvudbild) med
// identifiering, priser och färdig annonstext. Körs av kön i Apps Script, så
// appen kan vara stängd under tiden.
import { readFileSync } from "node:fs";
import { dbConfigured, dbModel } from "./db.js";
import { finalizeResult } from "./economics.js";
import { ask } from "./gemini.js";
import { LENS_USD, lensConfigured, lensListings, lensRetail, lensSearch, lensText } from "./lens.js";
import { mergeSettings } from "./settings.js";
import { geminiScan, toPriceRaw, verifyArticle } from "./simple.js";
import { findOnTradera, mergeListings, traderaConfigured } from "./tradera.js";

export const LISTING_PROMPT = readFileSync(new URL("../prompts/tradera-annons.md", import.meta.url), "utf8");
const TITLE_MAX = 80;
// AI:n tittar på högst 3 bilder (annonsen kan ha upp till 8).
export const AI_IMAGES = 3;
const DESCRIPTION_MAX = 7000;

// "från min egen samling", "ur vår samling", "privat samling" …
const FORBIDDEN = /\b(min|mitt|mina|vår|vårt|våra|egen|egna|privat|privata)\s+(egen\s+|egna\s+)?samling(ar|en)?\b/i;
// Löften om hemmet går inte att hålla (begagnat inköpt, hund i hemmet).
const HOME_CLAIM = /rökfri|djurfri/i;

// Tradera är standard. Vinted bara för kläder, skor och väskor.
const VINTED = /kläd|klänning|tröj|jacka|kappa|byxor|jeans|kjol|skjorta|blus|t-shirt|linne|kavaj|kostym|underkläd|strump|mössa|halsduk|vantar|handskar|sko|skor|känga|kängor|stövl|sandal|sneaker|väska|handväska|ryggsäck|plånbok/i;
export function channelFor(item) {
  const text = [item?.category, item?.name, item?.model].filter(Boolean).join(" ");
  return VINTED.test(text) ? "Vinted" : "Tradera";
}

// Rubrik och beskrivning kontrolleras av servern oavsett vad AI:n skrev:
// förbjudna formuleringar bort, din fasta avslutning exakt sist, längdgränser.
export function checkListingText({ title, description, closing = "" }) {
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
  const end = String(closing ?? "").trim();
  for (const line of lines) {
    if (end && line.trim() === end) continue; // läggs till sist nedan
    if (FORBIDDEN.test(line) || HOME_CLAIM.test(line)) {
      // Ta bort meningen, inte hela stycket.
      const cleaned = line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => {
          if (FORBIDDEN.test(sentence)) fixes.push("En formulering om egen samling togs bort.");
          else if (HOME_CLAIM.test(sentence)) fixes.push("En formulering om rökfritt/djurfritt hem togs bort.");
          else return true;
          return false;
        })
        .join(" ")
        .trim();
      if (cleaned) kept.push(cleaned);
      continue;
    }
    kept.push(line.trimEnd());
  }
  let body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const max = DESCRIPTION_MAX - (end ? end.length + 2 : 0);
  if (body.length > max) {
    body = body.slice(0, max).trim();
    fixes.push("Beskrivningen kortades.");
  }
  return { title: t, description: [body, end].filter(Boolean).join("\n\n"), fixes };
}

// ---------- Schleich: fast mall (alla figurer är begagnade) ----------
// Rubrik: Schleich + ras + djurtyp + modellnummer + (årtal), t.ex.
// "Schleich Tinker sto 13279 (2003-08)". Text: rubriken + "i lekt men bra skick
// enligt bild." + ev. en mening om brister från din anteckning + din avslutning.
// Lägsta utpris för Schleich-hästar: föl och ponnyer 49 kr, övriga hästar 69 kr.
// Avgörs av rubriken/annonsnamnet (ras + djurtyp, t.ex. "Tinker sto", "Haflinger föl").
export const MIN_PRICE = { foal: 49, horse: 69 };
const FOAL = /föl|ponny|pony|shetland|foal/i;
const HORSE = /häst|\bsto\b|hingst|valack|horse|mare\b|stallion|gelding/i;
export function minPriceFor(text) {
  const t = String(text ?? "");
  if (FOAL.test(t)) return { min: MIN_PRICE.foal, kind: "föl/ponny" };
  if (HORSE.test(t)) return { min: MIN_PRICE.horse, kind: "häst" };
  return null;
}

// Pris ur databasen (modellens sålda annonser senaste 4 månaderna). Minst 3 sålda,
// annars gäller Tradera-sökningen som förut. Normalt: sålt median. Mättad modell
// (minst 2 billigare till salu och under hälften säljs): lägg dig vid billigaste
// till salu, men aldrig under den undre kvartilen av vad den sålt för.
export const MIN_SOLD = 3;
export function marketPrice(m) {
  if (!m || !(m.sold >= MIN_SOLD) || !(m.median > 0)) return null;
  if (m.asks_below_median >= 2 && m.sell_through != null && m.sell_through < 50) {
    return { price: Math.max(m.p25 ?? 0, m.active_low ?? 0), basis: `billigaste till salu – ${m.asks_below_median} ligger under medianen och ${m.sell_through} % säljs` };
  }
  return { price: m.median, basis: `sålt median, ${m.sold} st senaste 4 mån` };
}

export const isSchleich = (item) => /schleich/i.test([item?.brand, item?.name].filter(Boolean).join(" "));

// "2003-2008" → "2003-08", "2003" → "2003"; allt annat → "" (hellre inget årtal än fel).
export function formatYears(value) {
  const m = /^\s*((?:19|20)\d\d)\s*(?:[-–]\s*((?:19|20)?\d\d))?\s*$/.exec(String(value ?? ""));
  if (!m) return "";
  if (!m[2]) return m[1];
  const end = m[2].length === 2 ? m[1].slice(0, 2) + m[2] : m[2];
  if (Number(end) < Number(m[1])) return "";
  return end.slice(0, 2) === m[1].slice(0, 2) ? `${m[1]}-${end.slice(2)}` : `${m[1]}-${end}`;
}

export function schleichTitle({ name, number, years }) {
  const clean = String(name ?? "").replace(/schleich/gi, "").replace(/\(.*?\)/g, "").replace(/\b\d{4,6}\b/g, "").replace(/\s+/g, " ").trim();
  const y = formatYears(years);
  return ["Schleich", clean, number, y && `(${y})`].filter(Boolean).join(" ");
}

export function schleichDescription({ title, defect = "" }) {
  const d = String(defect ?? "").trim();
  return `${title} i lekt men bra skick enligt bild.${d ? ` ${d}` : ""}`;
}

// Din anteckning → en kort mening om brister (eller inget, om den inte handlar om skicket).
const DEFECT_PROMPT = `Säljaren har skrivit en anteckning om en begagnad leksaksfigur som ska säljas på Tradera. Om anteckningen beskriver skick, brister eller något som saknas: skriv om den till EN kort, saklig mening på svenska för annonsen, t.ex. "Saknar svansen." eller "Lite färgslitage på manen.". Handlar den om något annat (märke, nummer, pris, egna påminnelser): svara med tom text. Hitta aldrig på något som inte står i anteckningen.
Svara ENDAST med JSON: {"sentence": ""}`;
async function defectSentence(note, deps) {
  if (!note) return { sentence: "", usd: 0 };
  const r = await (deps.defect ?? ((prompt) => ask([], prompt, undefined, { search: false, temperature: 0 })))(
    `${DEFECT_PROMPT}\n\nAnteckning: "${note}"`,
  );
  return { sentence: String(r.raw?.sentence ?? "").trim(), usd: r.usd ?? 0 };
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
    // Numret står i annonsen; du bekräftar det i granskningen innan den godkänns.
    artikelnummer: article?.number ?? "",
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
  // Först bara huvudbilden; går modellen inte att fastställa tittar Gemini på upp till 3 bilder.
  const identify = (imgs) => (deps.gemini ?? geminiScan)({ images: imgs, hints: lensHints, note: fullNote, buyPrice: 0, settings, lens: Boolean(lens) });
  let g = await identify(images.slice(0, 1));
  steps.push({ step: "Gemini", usd: g.usd });
  if (images.length > 1 && !confirmed && (!g.raw?.item?.article_number || g.raw?.item?.confidence_id === "low")) {
    g = await identify(images.slice(0, AI_IMAGES));
    steps.push({ step: "Gemini (fler bilder)", usd: g.usd });
    flags.push(`Modellen gick inte att fastställa från huvudbilden – ${Math.min(images.length, AI_IMAGES)} bilder användes.`);
  }
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

  // 4. Annonstext. Schleich: fast mall. Övrigt: AI:n skriver enligt prompten (med bilderna, utan sökning).
  const closing = settings.listing.closing;
  let draft;
  if (isSchleich(result.item)) {
    const raw = g.raw?.item ?? {};
    const title = schleichTitle({ name: raw.listing_name || result.item.model || result.item.name, number: article?.number, years: raw.production_years });
    const defect = await defectSentence(note, deps);
    steps.push({ step: "Brister", usd: defect.usd });
    draft = { title, description: schleichDescription({ title, defect: defect.sentence }) };
    if (raw.production_years && !formatYears(raw.production_years)) flags.push(`Årtalet "${raw.production_years}" kunde inte tolkas och togs inte med.`);
  } else {
    const written = await (deps.write ?? ((imgs, prompt) => ask(imgs, prompt, undefined, { search: false, temperature: 0.2 })))(
      images.slice(0, AI_IMAGES),
      textPrompt({ item: result.item, article, note, marketNote: result.market_note }),
    );
    steps.push({ step: "Annonstext", usd: written.usd ?? 0 });
    draft = { title: written.raw?.title, description: written.raw?.description };
  }
  const text = checkListingText({ ...draft, closing });

  // Modellens statistik i databasen (bara bekräftade/verifierade nummer).
  let price = result.economics.list_price;
  let listBasis = result.economics.list_basis;
  let market = null;
  const number = article?.verified ? article.number : "";
  if (number && isSchleich(result.item) && (deps.market || dbConfigured())) {
    try {
      market = await (deps.market ?? dbModel)(number);
      const mp = marketPrice(market);
      if (mp) {
        if (price && price !== mp.price) flags.push(`Priset från databasen: ${mp.price} kr (Tradera-sökningen gav ${price} kr).`);
        price = mp.price;
        listBasis = mp.basis;
      } else if (market) {
        flags.push(`Bara ${market.sold} sålda ${number} i databasen – priset bygger på Tradera-sökningen.`);
      }
    } catch (err) {
      flags.push(`Databasen kunde inte läsas (${err.message}).`);
    }
  }

  // Lägsta pris för Schleich-hästar, även när marknadsdata saknas.
  const floor = isSchleich(result.item) ? minPriceFor(`${text.title} ${g.raw?.item?.listing_name ?? ""}`) : null;
  if (floor && !(price >= floor.min)) {
    flags.push(`Priset höjt till lägsta pris för ${floor.kind}: ${floor.min} kr${price ? ` (marknaden gav ${price} kr)` : ""}.`);
    price = floor.min;
    listBasis = `lägsta pris för ${floor.kind}`;
  }

  const usd = steps.reduce((sum, s) => sum + (s.usd ?? 0), 0);
  return {
    item: result.item,
    article,
    confirmed: confirmed || "",
    candidates: candidateNumbers({ article, candidates: g.raw?.candidates, lensNumbers: lens?.numbers }),
    price,
    list_basis: listBasis,
    for_sale: result.for_sale,
    market,
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
