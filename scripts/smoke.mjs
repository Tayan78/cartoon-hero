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
  if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { ok: true, listings: [], sellers: [], purchases: [] } });
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
