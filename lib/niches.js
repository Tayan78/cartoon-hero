// Nischerna som bevakas: Schleich-djur (det du säljer i dag) och Smurfar
// (möjlig expansion). Varje nisch har sökord på Tradera, vad som räknas till
// nischen och hur partier delas upp i grupper för normalpriset per figur.
const SMURF = /smurf|smölf/i;
const SCHLEICH = /schleich/i;

export const NICHES = {
  djur: {
    id: "djur",
    label: "Schleich-djur",
    query: "schleich",
    // Schleich men inte smurfar (Schleich har gjort smurfar – de räknas till Smurfar).
    match: (text) => SCHLEICH.test(text) && !SMURF.test(text),
    // Inte figurer: tillbehör (staket, stall, hinder …), tryck och andra märken.
    exclude: /\b(kort|tidning|tidningar|bok|böcker|klistermärken|stickers)\b|tillbehör|staket|hage|stall|hinder|grind|foder|sadel|sadlar|träns|vagn|släp|transport|byggnad|hus\b|lada|bondgård|playmobil|lego\b|papo|collecta|bullyland|mojo/i,
    group: (title) => (/häst|föl|hingst|\bsto\b|ponny|valack/i.test(title) ? "hästar" : "blandat"),
    groups: ["hästar", "blandat"],
  },
  smurfar: {
    id: "smurfar",
    label: "Smurfar",
    query: "smurf",
    match: (text) => SMURF.test(text),
    // Figurer, inte böcker, film, kläder, gosedjur, porslin eller spel.
    exclude: /\b(bok|böcker|album|serietidning|tidning|tidningar|dvd|vhs|film|blu-?ray|cd|lp|vinyl|t-shirt|tröja|pyjamas|kläder|lakan|påslakan|gosedjur|mjukdjur|plysch|mugg|muggar|kopp|koppar|glas|tallrik|pussel|spel|kort|klistermärken|stickers|nyckelring)\b|tablett|godis|plåtask|plåtburk|burk|förpackning|tom ask|hus\b|svamphus/i,
    group: () => "smurfar",
    groups: ["smurfar"],
  },
};

export const nicheList = Object.values(NICHES);
export const getNiche = (id) => NICHES[id] ?? NICHES.djur;

// Vilken nisch en annons hör till (rubrik + text), eller null. Smurfar först.
export function nicheOf(text) {
  const t = String(text ?? "");
  if (NICHES.smurfar.match(t)) return "smurfar";
  if (NICHES.djur.match(t)) return "djur";
  return null;
}

// Allt som hör till någon nisch (används vid insamling).
export const ANY_NICHE = /schleich|smurf|smölf/i;
