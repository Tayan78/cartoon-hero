// Produktnycklar: en annons kopplas till en standardiserad produkt, t.ex.
// SCHLEICH-13729, så att statistik kan räknas per modell oavsett hur säljaren
// skrivit rubriken. Här bara säkra kopplingar från modellnummer (rubrik eller
// text); AI-tolkning av rubriker utan nummer kommer som ett eget steg och sparas
// med metod och säkerhet – rådatan i annonsen skrivs aldrig över.
import { numberFromText } from "./seller.js";

// Bara Schleich-annonser (inklusive serier och smurfar) får Schleich-nycklar –
// ett femsiffrigt nummer i en Lego-annons är ett Lego-set.
export const SCHLEICH_CONTEXT = /schleich|bayala|eldrador|smurf|smölf/i;
// Schleichs modellnummer: fem siffror, inte ett pris ("12500 kr").
const NUMBER = /\b([12478]\d{4})\b(?!\s*(?:kr|:-|sek|kronor))/gi;

export const productKey = (modelNumber) => `SCHLEICH-${modelNumber}`;

// Annonsens produkter: [{ key, model_number, method, confidence }]. Flera nummer
// i rubriken = flera produkter (paket), med lite lägre säkerhet.
export function productLinks({ title, text } = {}) {
  const t = String(title ?? "");
  if (!SCHLEICH_CONTEXT.test(`${t} ${text ?? ""}`)) return [];
  const inTitle = [...new Set([...t.matchAll(NUMBER)].map((m) => m[1]))];
  if (inTitle.length) {
    return inTitle.map((n) => ({ key: productKey(n), model_number: n, method: "rubrik", confidence: inTitle.length === 1 ? 0.95 : 0.8 }));
  }
  const fromText = numberFromText(text);
  if (fromText.number && !fromText.ambiguous && /^[12478]/.test(fromText.number)) {
    return [{ key: productKey(fromText.number), model_number: fromText.number, method: "text", confidence: 0.8 }];
  }
  return [];
}
