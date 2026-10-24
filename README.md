# Loppisskannern – fas 1 (snabbskanning)

Privat PWA för reselling. Fota ett föremål (1–4 vinklar) → (valfritt inköpspris) → skanna → resultatkort med medianpris, köp-poäng och verdict. Varje skanning loggas i Google Sheet med bild i Drive.

## Så fungerar det

Skanningen görs i tre steg, så att den dyra modellen bara tittar på bilderna och den billiga gör det token-tunga sökandet:

```
iPhone (PWA) ──1–4 bilder──▶ Vercel /api/scan
                               1a. Google Vision Web Detection (bildsök, ~0,0035 $/bild, 1000 gratis/mån)
                               1b. Gemini + Google-sökning     (hittar exakt modell/artikelnummer; parallellt med 1a)
                               2. Identifiering                (ser bilderna + bildsökets träffar; standard Opus 5.5)
                               3. Prissökning                  (bara text; läser färdiga söksidor för sålda objekt
                                                                på artikelnumret, webbsökning som reserv; standard Haiku 5.5)
     ▲                         │
     └── strömmat svar ◀───────┤
                               └──▶ Apps Script ──▶ Drive (huvudbilden) + Sheet (rad)
```

- **Identifieringen syns direkt** efter steg 2; priser och källor fylls på när sökningen är klar.
- **Modell per steg** väljs i appens inställningar (eller `ID_MODEL` / `SEARCH_MODEL` i Vercel). Bildsöket kan slås av där också. Jämför kostnad och träffsäkerhet i Sheet.
- **Artikelnummer först:** nummer som återkommer i bildsökets träffar lyfts fram, identifieringen ger upp till 3 kandidater, och prissteget söker på märke + artikelnummer.
- **Färdiga söksidor:** servern bygger adresser till Tradera avslutade objekt, eBay sålda objekt och Tradera till salu nu, som modellen läser direkt (web_fetch, bara eBay sålda eftersom Tradera blockerar hämtning; max 2 sidor à 4000 token, `MAX_FETCHES`). Går de inte att läsa används webbsökning. Länkarna visas också på resultatkortet så att du kan kontrollera själv.
- **Till salu nu** visas som eget intervall men påverkar aldrig medianen.
- **Prispanelen** högst upp på kortet: *Lägg ut för* = lägsta pris till salu just nu (utan annonser: sålt median, annars uppskattningen). *Bud ned till* = sålt median när det finns sålda jämförelser. En prislinje visar annonserna som prickar och det sålda spannet som grönt fält. Netto och köp-poäng räknas på utpriset; nettot vid budgränsen visas bredvid.
- **Info om föremålet** (valfritt textfält, t.ex. märke, modell, storlek från etiketten) skickas till Gemini (används i Google-sökningarna), till identifieringen (räknas som avläst på föremålet) och till prissökningen. Sparas i Sheet. Cloud Vision tar bara bild och använder inte texten.
- **Bara två källor:** webbsökningen är låst till `tradera.com` och `ebay.*` (max 4 sökningar, `MAX_SEARCHES`). Bara sålda priser räknas. eBay-priser redovisas separat som internationellt pris.
- **Ärlighet om osäkerhet:** servern räknar om ekonomin själv och tillämpar regler utöver modellens bedömning:
  - Inga sålda jämförelser → säkerhet "låg", poäng max 25, tydlig flagga.
  - Inga Tradera-träffar → säkerhet sänks (aldrig "hög"), −10 poäng, flagga.
  - Netto ≤ 0 → poäng max 30.
  - Verdict följer poängen: 70–100 Köp, 40–69 Kanske, 0–39 Låt bli.
- **Avgifter, frakt och växelkurser** ställs in i appen (⚙︎) per plattform. Inget är hårdkodat; standardvärdena i `lib/settings.js` är bara utgångsvärden. Kolla särskilt Traderas avgift mot dina faktiska villkor.
- **Kostnad per skanning** loggas i Sheet och visas under resultatkortet, uppdelad på bildsök, identifiering och prissök. Bildsöket räknas alltid som betalt, även inom de 1000 gratis bilderna per månad.
- **Extra vinklar** (baksida, stämpel, etikett) kostar ungefär 0,006 $ per bild med Opus eftersom bara identifieringen ser bilderna. Bara huvudbilden sparas i Drive.

## Projektstruktur

```
api/scan.js           POST: skanning, strömmar status → prelim → result → logged
api/save.js           POST: "Spara till lager" (fliken Lager i Sheet)
api/ping.js           GET: testa lösenord och konfiguration
lib/claude.js         Anrop till Claude: identifiering + prissökning (web search, pause_turn, fallback)
lib/vision.js         Google Cloud Vision Web Detection (bildsök)
lib/models.js         Tillåtna modeller, priser och vad de stöder
lib/prompt.js         Instruktioner och JSON-scheman till modellerna
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

### 2b. Google Cloud Vision (bildsök)
1. Gå till <https://console.cloud.google.com> och skapa ett projekt, t.ex. "Loppisskannern".
2. **Fakturering:** koppla ett betalkonto till projektet (krävs även för gratisnivån – de första 1000 bilderna per månad är gratis).
3. **API:er och tjänster → Bibliotek:** sök på **Cloud Vision API** och tryck **Aktivera**.
4. **API:er och tjänster → Inloggningsuppgifter → Skapa inloggningsuppgifter → API-nyckel.**
5. Tryck på nyckeln → **API-begränsningar → Begränsa nyckeln → Cloud Vision API** → Spara. Då kan nyckeln inte användas till något annat om den skulle läcka.
6. Kopiera nyckeln (börjar med `AIza`) till `GOOGLE_VISION_API_KEY` i Vercel.

Utan nyckeln fungerar appen ändå, bara utan bildsök.

### 2c. Gemini (Google-sökning för exakt modell)
1. Gå till <https://aistudio.google.com> och logga in med ditt Google-konto.
2. Tryck **Get API key → Create API key** (välj gärna samma Google Cloud-projekt som för Vision).
3. Lägg in nyckeln som `GEMINI_API_KEY` i Vercel.

Gemini söker på Google med bilden och föreslår modell och artikelnummer. Ett nummer från Gemini används i prissökningen bara om Gemini faktiskt sökte. Saknar huvudmodellen kvot eller finns den inte för nyckeln provas reservmodeller (`GEMINI_FALLBACK_MODELS`, standard `gemini-3.5-flash,gemini-2.5-flash`). "Testa anslutning" visar per modell om den fungerar. Kan slås av i appens inställningar. Priserna för Gemini (token och sökningar) är satta efter tredjepartsuppgifter – kontrollera mot Googles prislista och justera `GEMINI_INPUT_USD`, `GEMINI_OUTPUT_USD`, `GEMINI_SEARCH_USD` vid behov.

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
   | `GOOGLE_VISION_API_KEY` | nyckeln från steg 2b |
   | `GEMINI_API_KEY` | nyckeln från steg 2c |
   | `ID_MODEL` | *(valfritt)* standard `claude-opus-5-5` |
   | `SEARCH_MODEL` | *(valfritt)* standard `claude-haiku-5-5` |
   | `MAX_SEARCHES` | *(valfritt)* standard `4` |

3. **Deploy** (eller Redeploy efter att du lagt in variablerna). Du får en adress som `https://loppisskannern-xxx.vercel.app`.

API-nyckeln finns bara på servern och skickas aldrig till telefonen.

### 4. Spara appen på hemskärmen (iPhone 15)
1. Öppna adressen i **Safari** (måste vara Safari för hemskärmsappar på iOS).
2. Appen öppnar inställningarna första gången: skriv in ditt `APP_TOKEN`, tryck **Testa anslutning** (ska visa ✓, API-nyckel: ja, Bildsök: ja, Google Sheet: ja) och **Spara**.
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

Ungefärlig kostnad per skanning med en bild (uppskattning, se exakta siffror i Sheet):

| Steg | Standard | Ungefär |
|---|---|---|
| Bildsök | Google Vision | 0–0,0035 $ |
| Identifiering | Opus 5.5 | ~0,01–0,015 $ (+~0,006 $ per extra vinkel) |
| Prissök | Haiku 5.5, max 4 sökningar | ~0,02–0,04 $ (sökningarna kostar 0,01 $ st) |

Stegen körs efter varandra, så en skanning tar ungefär 10–30 s. Identifieringen syns efter ungefär 5–10 s. Blir prissökningen för svag med Haiku: prova Sonnet 5.5 för prissök i inställningarna.

## Nästa faser (inte påbörjade)
Fas 2 batchläge, fas 3 granskning, fas 4 berikning och annonser – enligt byggprompten, efter att fas 1 är testad.
