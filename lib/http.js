import { timingSafeEqual } from "node:crypto";

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Appen är privat: varje anrop måste ha rätt token i headern x-app-token.
export function checkAuth(request) {
  const expected = process.env.APP_TOKEN;
  if (!expected) return json({ error: "APP_TOKEN saknas på servern" }, 500);
  const given = request.headers.get("x-app-token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json({ error: "Fel lösenord" }, 401);
  return null;
}

// "data:image/jpeg;base64,..." → { mediaType, data }
export function parseDataUrl(value) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(value ?? "");
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}
