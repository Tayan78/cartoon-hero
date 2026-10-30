# Bevakning – pling när ett bra Köp nu-parti läggs ut

Körs i Cloudflare (`worker/`), oberoende av appen och telefonen.

## Så fungerar det
1. Var 10:e sekund söks de 50 nyaste annonserna i kategorin *Miniatyrer & leksaksfigurer* (1000532). Traderas gräns är 10 000 anrop per dygn och metod – 8 640 sökningar per dygn ryms.
2. Nya annonser som är **partier i en bevakad nisch** (i dag Schleich-djur), har **antal i rubriken** och går att **köpa direkt** (Köp nu, eller auktion med Köp nu-pris) blir kandidater.
3. Kandidaten hämtas för frakten och värderas med samma kod som Fynd: antal × netto per figur från styckförsäljningen i fliken Marknad, köparskydd (2 kr + 5 %) och frakt, och köpreglerna för småfigurer (grön vid 2×).
4. **Grönt → notis via ntfy** med bild, totalpris, värde och länk som öppnar annonsen.

Första körningen räknar allt som redan ligger ute som sett, så det kommer ingen notisflod. Marknadspriserna hämtas från appen (`/api/marketdata`, `singles`) en gång i timmen. Köpreglerna är standardreglerna (grön vid 2×, avgift 10 %), inte de som är ändrade i telefonen.

## Styra bevakningen
Adress: `https://loppis-bevakning.<din-subdomän>.workers.dev` – lägg till `?token=<APP_TOKEN>`:
- `/status` – går den, senaste sökning, antal sedda, kandidater, notiser, senaste fel
- `/test` – skickar en testnotis
- `/test?annons=1` – skickar en påhittad träff (grönt Köp nu-parti) så du ser hur en riktig notis ser ut
- `/pause`, `/resume`

## Fler nischer
Lägg till nischen i `lib/niches.js` och dess id i `WATCH_NICHES` i `worker/src/watch.js`. Värderingen kräver styckförsäljning i fliken Marknad för nischen (bevaka säljare i nischen först).

## Deploy
GitHub Actions (`.github/workflows/deploy-watcher.yml`) deployar när `worker/` eller `lib/` ändras på master. Hemligheter i GitHub: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TRADERA_APP_ID`, `TRADERA_APP_KEY`, `APP_TOKEN`, `NTFY_TOPIC` och valfritt `NTFY_TOKEN` (access token från ett gratis konto på ntfy.sh – då gäller ntfy:s gränser per konto i stället för per IP, vilket behövs eftersom Cloudflares IP-adresser delas med många). Misslyckas en notis visar `/test` och `/status` (`ntfy_error`) ntfy:s svar. Kontrollera dem med Actions → *Kontrollera hemligheter*.
