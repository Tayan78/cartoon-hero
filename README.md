# Loppisskannern – fas 1 (snabbskanning)

Privat PWA för reselling. Fota ett föremål → (valfritt inköpspris) → skanna → resultatkort med medianpris, köp-poäng och verdict. Varje skanning loggas i Google Sheet med bild i Drive.

## Så fungerar det

```
iPhone (PWA)  ──bild 1500 px──▶  Vercel /api/scan  ──▶  Claude (bild + web search: Tradera, eBay sold)
     ▲                                  │
     └──── strömmat svar (NDJSON) ◀─────┤
                                        └──▶  Apps Script  ──▶  Drive (bild) + Sheet (rad)
```

- **Preliminärt svar direkt:** servern kör en snabb identifiering (utan sökning) parallellt med den fulla skanningen. Namnet syns efter några sekunder, priser och källor fylls på när sökningen är klar.
- **Bara två källor:** webbsökningen är låst till `tradera.com` och `ebay.*` (max 6 sökningar). Bara sålda priser räknas. eBay-priser redovisas separat som internationellt pris.
- **Ärlighet om osäkerhet:** servern räknar om ekonomin själv och tillämpar regler utöver modellens bedömning:
  - Inga sålda jämförelser → säkerhet "låg", poäng max 25, tydlig flagga.
  - Inga Tradera-träffar → säkerhet sänks (aldrig "hög"), −10 poäng, flagga.
  - Netto ≤ 0 → poäng max 30.
  - Verdict följer poängen: 70–100 Köp, 40–69 Kanske, 0–39 Låt bli.
- **Avgifter, frakt och växelkurser** ställs in i appen (⚙︎) per plattform. Inget är hårdkodat; standardvärdena i `lib/settings.js` är bara utgångsvärden. Kolla särskilt Traderas avgift mot dina faktiska villkor.
- **Kostnad per skanning** (token + webbsökningar, i USD och SEK) loggas i Sheet och visas under resultatkortet.

## Projektstruktur

```
api/scan.js           POST: skanning, strömmar status → prelim → result → logged
api/save.js           POST: "Spara till lager" (fliken Lager i Sheet)
api/ping.js           GET: testa lösenord och konfiguration
lib/claude.js         Anrop till Claude (bild + web search, pause_turn, fallback)
lib/prompt.js         Instruktioner och JSON-schema till modellen
lib/economics.js      Ekonomi, ärlighetsregler, kostnad, JSON-tolkning
lib/settings.js       Standardvärden för avgifter/frakt/växelkurser
lib/storage.js        Anrop till Apps Script
lib/mock.js           Testläge utan API-nyckel
apps-script/Code.gs   Google Apps Script: sparar bild i Drive och rad i Sheet
public/               PWA:n (index.html, app.js, styles.css, manifest, service worker, ikoner)
scripts/dev-server.mjs  Lokal server
test/                 Enhetstester
```

## Installation

### 1. Anthropic API-nyckel
Skapa en nyckel på <https://console.anthropic.com> → API Keys. Lägg in lite krediter (Billing).

### 2. Google Sheet + Apps Script
1. Skapa ett nytt Google Sheet, t.ex. "Loppisskannern".
2. **Tillägg → Apps Script**. Ersätt innehållet i `Code.gs` med `apps-script/Code.gs` från det här projektet.
3. **Projektinställningar (kugghjulet) → Skriptegenskaper → Lägg till:** `SECRET` = en lång slumpad sträng (t.ex. från `openssl rand -hex 24`).
4. Välj funktionen `setup` i verktygsfältet och tryck **Kör**. Godkänn behörigheterna (Drive + Sheets). Flikarna *Skanningar* och *Lager* och Drive-mappen *Loppisskannern/Skanningar* skapas.
5. **Driftsätt → Ny driftsättning → Typ: Webbapp.** Kör som: *Jag*. Vem har åtkomst: *Alla*. Kopiera webbappens URL (slutar på `/exec`).
   - "Alla" behövs för att Vercel ska kunna anropa den; skriptet avvisar allt som inte har rätt `SECRET`.
   - Om du ändrar i skriptet senare: **Driftsätt → Hantera driftsättningar → redigera → Ny version**, annars körs den gamla koden.

### 3. Deploya till Vercel
1. Skapa ett konto på <https://vercel.com> och välj **Add New → Project → Import** detta GitHub-repo.
   Framework Preset: *Other*. Inga build-inställningar behövs (`vercel.json` pekar ut `public/`).
2. Under **Settings → Environment Variables**, lägg till:

   | Namn | Värde |
   |---|---|
   | `ANTHROPIC_API_KEY` | din API-nyckel |
   | `APP_TOKEN` | ditt personliga lösenord till appen (lång slumpad sträng) |
   | `APPS_SCRIPT_URL` | webbappens URL från steg 2.5 |
   | `APPS_SCRIPT_SECRET` | samma värde som `SECRET` i steg 2.3 |
   | `CLAUDE_MODEL` | *(valfritt)* standard `claude-opus-5-5` |
   | `SCAN_EFFORT` | *(valfritt)* `low` (standard, snabbast) / `medium` / `high` |

3. **Deploy** (eller Redeploy efter att du lagt in variablerna). Du får en adress som `https://loppisskannern-xxx.vercel.app`.

API-nyckeln finns bara på servern och skickas aldrig till telefonen.

### 4. Spara appen på hemskärmen (iPhone 15)
1. Öppna adressen i **Safari** (måste vara Safari för hemskärmsappar på iOS).
2. Appen öppnar inställningarna första gången: skriv in ditt `APP_TOKEN`, tryck **Testa anslutning** (ska visa ✓, API-nyckel: ja, Google Sheet: ja) och **Spara**.
3. Tryck på **Dela-knappen → Lägg till på hemskärmen → Lägg till**.
4. Starta appen från ikonen. Första gången du fotar frågar iOS om kameraåtkomst.

Lösenordet sparas i appen på telefonen. Rensar du Safaris webbplatsdata får du skriva in det igen.

## Köra lokalt

```bash
npm install
npm test                 # enhetstester
npm run dev:mock         # testläge utan API-nyckel, lösenord "test" → http://localhost:3000
cp .env.example .env.local   # fyll i värdena
npm run dev              # riktiga anrop
```

## Fart och kostnad

Standard är `claude-opus-5-5` med låg effort, och en skanning gör vanligtvis 2–4 webbsökningar. Tidsåtgången styrs mest av sökningarna. Fullständigt svar tar sannolikt mer än 10 sekunder (10–30 s), men namnet syns redan efter några sekunder. Är det för långsamt eller dyrt kan du prova `CLAUDE_MODEL=claude-sonnet-5-5`. Jämför tid och kostnad i Sheet (kolumnerna *Tid (ms)* och *Kostnad SEK*).

## Nästa faser (inte påbörjade)
Fas 2 batchläge, fas 3 granskning, fas 4 berikning och annonser – enligt byggprompten, efter att fas 1 är testad.
