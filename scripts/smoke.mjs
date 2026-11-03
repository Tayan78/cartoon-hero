// Röktest: startar appen i en riktig webbläsare (Chromium via Playwright) med
// låtsade API-svar och kontrollerar att den startar utan fel och att flikarna
// och inställningarna går att öppna. Körs i GitHub Actions på varje PR.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("../public/", import.meta.url).pathname;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith("/api/")) {
    const body = JSON.parse(route.request().postData() || "{}");
    // En klar annons att granska, så att Granska och annonsvyn testas.
    if (url.pathname === "/api/listings" && body.action === "list") {
      return route.fulfill({ json: { ok: true, listings: [{ id: "G1", status: "Klar", title: "Schleich Tinker sto 13773", price: 89, channel: "Tradera", image_urls: [], listing: { price: 89, list_basis: "sålt median", article: { number: "13773" }, market: { number: "13773", sold: 3, median: 89, active: 1, recent: [] } } }] } });
    }
    return route.fulfill({ json: { ok: true, listings: [], sellers: [], purchases: [] } });
  }
  const file = join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
  return existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: "" });
});
await page.addInitScript(() => localStorage.setItem("token", JSON.stringify("test")));
await page.goto("http://app.local/");
await page.waitForTimeout(800);

for (const tab of ["groups", "capture", "analytics", "ops", "home"]) {
  await page.click(`[data-tab="${tab}"]`, { timeout: 3000 }).catch((e) => fail(`fliken ${tab} går inte att klicka: ${e.message}`));
  await page.waitForTimeout(300);
}
// Fota → Tillbehör: läget visar typ/pris och en förhandsrubrik utan AI.
await page.click('[data-tab="capture"]');
await page.click('#c-kind [data-kind="accessory"]', { timeout: 3000 }).catch((e) => fail(`Tillbehör går inte att välja: ${e.message}`));
await page.waitForTimeout(200);
if (!(await page.isVisible("#c-acc"))) fail("Tillbehörspanelen syns inte");
else if (!/sadel/i.test(await page.textContent("#c-acc-preview"))) fail("förhandsrubriken för tillbehör saknas");
await page.click('#c-kind [data-kind="figure"]').catch(() => {});
// Annonser → Granska: markera/avmarkera och öppna annonsen.
await page.click('[data-tab="groups"]');
await page.waitForTimeout(400);
await page.click('#g-tabs [data-panel="review"]').catch((e) => fail(`Granska går inte att öppna: ${e.message}`));
await page.waitForTimeout(300);
await page.click("#g-sent .open", { timeout: 3000 }).catch((e) => fail(`annonsen går inte att klicka: ${e.message}`));
await page.waitForTimeout(400);
if (!(await page.isVisible("#view-review"))) fail("annonsen öppnas inte i Granska");
await page.click('[data-tab="home"]');
await page.waitForTimeout(300);
const homeVisible = await page.isVisible("#view-home");
if (!homeVisible) fail("Hem syns inte efter klick på fliken");
await page.click('[data-tab="ops"]');
await page.click("#o-go-settings", { timeout: 3000 }).catch((e) => fail(`Inställningar går inte att öppna: ${e.message}`));
await page.waitForTimeout(300);
if (!(await page.isVisible("#view-settings"))) fail("Inställningar syns inte");

// Fel i appens egen kod räknas; låtsade API-svar kan ge följdfel i enskilda vyer
// men aldrig stoppa starten.
const fatal = errors.filter((m) => /before initialization|is not defined|is not a function|Unexpected token|SyntaxError/.test(m));
for (const m of fatal) fail(`fel i appen: ${m}`);
console.log(fatal.length || process.exitCode ? "Röktestet misslyckades" : `✓ Appen startar och flikarna fungerar${errors.length ? ` (${errors.length} följdfel av låtsade svar)` : ""}`);
await browser.close();
