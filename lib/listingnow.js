// Direkt bearbetning: när en annons skickas till AI (eller får ett nytt
// modellnummer) tar appens server den på en gång, i stället för att vänta på
// Apps Script-timern som går en gång i minuten och tar en annons i taget.
// Varje annons bearbetas i ett eget anrop, så tio annonser går samtidigt.
// Timern finns kvar som reserv: misslyckas något här står annonsen kvar som
// Väntar/Bearbetas och tas av timern.
import { researchListing } from "./listing.js";
import { callAppsScript } from "./storage.js";

export const AI_IMAGES = 3;

// En bild från Drive (delad "alla med länken") som base64.
export async function driveImage(fileId, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`, { redirect: "follow", signal: AbortSignal.timeout(20000) });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/")) throw new Error("Bilden kunde inte hämtas från Drive");
  return { mediaType: "image/jpeg", data: Buffer.from(await res.arrayBuffer()).toString("base64") };
}

export async function processListingNow(id, { store = callAppsScript, research = researchListing, image = driveImage } = {}) {
  const claim = await store("claimListing", { id });
  // Äldre Apps Script utan claimListing, eller annonsen redan tagen: timern sköter den.
  if (!claim?.ok || !claim.job) return { skipped: true, reason: claim?.error ?? "inte i kön" };
  const job = claim.job;
  let result;
  try {
    const images = await Promise.all(job.fileIds.slice(0, AI_IMAGES).map((f) => image(f)));
    if (!images.length) throw new Error("Inga bilder");
    const listing = await research({
      images,
      note: String(job.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      confirmed: String(job.confirmed ?? "").trim().slice(0, 20),
      settings: job.settings,
    });
    result = { ok: true, listing };
  } catch (err) {
    result = { ok: false, error: err.source === "gemini" ? `Gemini: ${err.message}` : err.message || "Något gick fel" };
  }
  const saved = await store("saveListingResult", { id, result });
  return { ok: Boolean(saved?.ok), result };
}
