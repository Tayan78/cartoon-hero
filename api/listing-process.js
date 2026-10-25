// POST /api/listing-process – anropas av kön i Apps Script (inte av appen), en
// annons i taget: { id, images: [base64-jpeg, …] (1–3, första = huvudbild),
// note, confirmed, settings }. Svarar med den färdiga annonsen.
// Skyddas med samma hemlighet som Apps Script använder (APPS_SCRIPT_SECRET).
import { timingSafeEqual } from "node:crypto";
import { json } from "../lib/http.js";
import { researchListing } from "../lib/listing.js";
import { mockDefect, mockLens, mockListingText, mockSimple, mockTradera } from "../lib/mock.js";
import { findOnTradera } from "../lib/tradera.js";

const MOCK = process.env.MOCK === "1";
const MAX_IMAGES = 3;

function checkSecret(request) {
  const expected = process.env.APPS_SCRIPT_SECRET;
  if (!expected) return json({ ok: false, error: "APPS_SCRIPT_SECRET saknas på servern" }, 500);
  const a = Buffer.from(request.headers.get("x-script-secret") ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ ok: false, error: "Fel hemlighet" }, 401);
  return null;
}

export async function POST(request) {
  const denied = checkSecret(request);
  if (denied) return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Ogiltig förfrågan" }, 400);
  }
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter((d) => typeof d === "string" && /^[A-Za-z0-9+/=]+$/.test(d))
    .slice(0, MAX_IMAGES)
    .map((data) => ({ mediaType: "image/jpeg", data }));
  if (!images.length) return json({ ok: false, error: "Bilder saknas" }, 400);

  const deps = MOCK
    ? {
        lens: (img, fx) => mockLens(fx),
        gemini: (input) => mockSimple(input, () => {}),
        tradera: (input) => findOnTradera({ ...input, lens: null }, mockTradera),
        write: mockListingText,
        defect: mockDefect,
      }
    : {};
  try {
    const listing = await researchListing(
      {
        images,
        note: String(body.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
        confirmed: String(body.confirmed ?? "").trim().slice(0, 20),
        settings: body.settings,
      },
      deps,
    );
    return json({ ok: true, id: body.id, listing });
  } catch (err) {
    console.error("annons misslyckades:", err);
    return json({ ok: false, id: body.id, error: err.source === "gemini" ? `Gemini: ${err.message}` : err.message || "Något gick fel" }, 500);
  }
}
