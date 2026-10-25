// GET /bild/<drive-id>.jpg (omskrivning i vercel.json → /api/image?file=…)
// Visar en annonsbild från Drive som en vanlig .jpg-adress, så att ProLister kan
// hämta den vid import (Drives egna länkar saknar filändelse och går via
// omdirigeringar). Bara bilder som redan är delade "alla med länken" fungerar.
const DRIVE_ID = /^[A-Za-z0-9_-]{20,120}$/;

export async function GET(request) {
  const file = new URL(request.url).searchParams.get("file") ?? "";
  const id = file.replace(/\.(jpe?g|png)$/i, "");
  if (!DRIVE_ID.test(id)) return new Response("Ogiltig bild", { status: 400 });
  let res;
  try {
    res = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, { redirect: "follow", signal: AbortSignal.timeout(20000) });
  } catch {
    return new Response("Bilden kunde inte hämtas", { status: 502 });
  }
  const type = res.headers.get("content-type") ?? "";
  // Drive svarar med en HTML-sida om filen inte finns eller inte är delad.
  if (!res.ok || !type.startsWith("image/")) return new Response("Bilden finns inte eller är inte delad", { status: 404 });
  return new Response(res.body, {
    headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
