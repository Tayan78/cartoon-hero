// POST /api/save  { scan_id, image_url, result }  – "Spara till lager"
import { checkAuth, json } from "../lib/http.js";
import { callAppsScript, storageConfigured } from "../lib/storage.js";

export async function POST(request) {
  const denied = checkAuth(request);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ogiltig förfrågan" }, 400);
  }
  if (!body.scan_id || !body.result) return json({ error: "scan_id och result krävs" }, 400);
  if (process.env.MOCK === "1" && !storageConfigured()) return json({ ok: true, mock: true });

  const res = await callAppsScript("saveInventory", {
    scan_id: String(body.scan_id),
    image_url: String(body.image_url ?? ""),
    result: body.result,
  }).catch((err) => ({ ok: false, error: err.message }));
  return json(res, res.ok ? 200 : 502);
}
