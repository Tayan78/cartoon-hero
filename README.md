# Loppisskannern – fas 1 (snabbskanning)

Privat PWA för reselling. Fota ett föremål (1–4 vinklar) → (valfritt inköpspris) → skanna → resultatkort med utpris, köpbeslut (grön/gul/röd), vinst och multipel. Varje skanning loggas i Google Sheet med bild i Drive.

## Så fungerar det

**Enkelt läge (standard)**: två steg, och priset bygger på annonser till salu just nu – inga sålda priser.

```
iPhone (PWA) ──1–4 bilder + ev. info──▶ Vercel /api/scan
                               1. Google Lens via SerpApi      (huvudbilden: riktiga träffar med titel, länk och ofta pris,
                                                                sökt som i Sverige: hl=sv, country=se)
                                  – reserv utan SerpApi-nyckel: Cloud Vision Web Detection
                               2. Gemini                        (ett anrop, temperatur 0): identifierar föremålet utifrån
                                                                bilderna och Lens-träffarna. Annonserna = Lens-träffar med
                                                                pris (Gemini hittar inte på egna). Utan Lens söker Gemini själv.
                               3. Traderas API                  (aktiva annonser för modellnumret, om nycklarna finns)
                               4. Servern räknar utpris (lägsta Tradera/eBay-annons), netto, vinst, multipel och köpbeslutet
```

- Ett modellnummer räknas som bekräftat bara om det står i din info, i Google Lens-titlarna eller i bildsökets träffar. Geminis källstöd (`groundingSupports`) räcker inte – i testet gav det fel nummer med "stöd".
- Google Lens tar max 500 kB per bild; appen krymper huvudbilden tills den ryms.
- "Sverige": svenska sökord och sajter i prompten, plus Stockholms koordinater och `sv_SE` i `toolConfig.retrievalConfig` (dokumenterat för kartsökning; avvisas det körs anropet utan).
- **Visa rådata** längst ned på kortet visar Googles svar (Vision och Gemini) med en kopieringsknapp. Rådatan sparas inte i Sheet.

**Avancerat läge** (⚙︎ → Läge): den tidigare kedjan nedan, med Claude och försök att hitta sålda priser.

- **Identifieringen syns direkt** efter steg 2; priser och källor fylls på när sökningen är klar.
- **Prissökning med Gemini:** under ⚙︎ → Prissökning finns även *Gemini + Google-sökning*. Samma instruktioner som Claudes prissteg, men Googles index i stället för Claudes webbsökning (kan inte låsas till vissa sajter; prompten styr mot Tradera/eBay och andra källor filtreras bort).
- **Modell per steg** väljs i appens inställningar (eller `ID_MODEL` / `SEARCH_MODEL` i Vercel). Bildsöket kan slås av där också. Jämför kostnad och träffsäkerhet i Sheet.
- **Artikelnummer först:** nummer som återkommer i bildsökets träffar lyfts fram, identifieringen ger upp till 3 kandidater, och prissteget söker på märke + artikelnummer.
- **Färdiga söksidor:** servern bygger adresser till Tradera avslutade objekt, eBay sålda objekt och Tradera till salu nu, som modellen läser direkt (web_fetch, bara eBay sålda eftersom Tradera blockerar hämtning; max 2 sidor à 4000 token, `MAX_FETCHES`). Går de inte att läsa används webbsökning. Länkarna visas också på resultatkortet så att du kan kontrollera själv.
- **Till salu nu** visas som eget intervall men påverkar aldrig medianen.
- **Prispanelen** högst upp på kortet: *Lägg ut för* = lägsta pris till salu just nu (utan annonser: sålt median, annars uppskattningen). *Bud ned till* = sålt median när det finns sålda jämförelser. En prislinje visar annonserna som prickar och det sålda spannet som grönt fält. Netto och köpbeslut räknas på utpriset; nettot vid budgränsen visas bredvid.
- **Info om föremålet** (valfritt textfält, t.ex. märke, modell, storlek från etiketten) skickas till Gemini (används i Google-sökningarna), till identifieringen (räknas som avläst på föremålet) och till prissökningen. Sparas i Sheet. Cloud Vision tar bara bild och använder inte texten.
- **Bara två källor:** webbsökningen är låst till `tradera.com` och `ebay.*` (max 4 sökningar, `MAX_SEARCHES`). Bara sålda priser räknas. eBay-priser redovisas separat som internationellt pris.
- **Köpbeslutet räknas av servern** (`lib/decision.js`), aldrig av AI:n. Trösklarna ställs in under ⚙︎ → Köpregler.
  - Vinst = netto efter avgift och frakt − inköp. Multipel = netto / inköp.
  - Vanliga föremål: **Köp** (grön) om vinst ≥ 100 kr och (multipel ≥ 2,0 eller inköp ≥ 200 kr). **Tveksamt** (gul) om vinst > 0. **Låt bli** (röd) annars.
  - Småfigurer (märket Schleich eller utpris under 100 kr): grön från 2,0×, gul från 1,3×, röd under. Kortet påminner om att räkna på hela lotten.
  - Osäkert pris (låg säkerhet eller inga Tradera/eBay-annonser): högst gul, märkt "Osäkert pris".
  - Utan inköpspris räknas maxpriset bakvägen: *Betala inte mer än X kr* (grön gräns) och var vinsten tar slut.
  - Motiveringen: Gemini får det färdiga beslutet och siffrorna och skriver en mening (utan Google-sökning, ca 0,01 kr). En mening som säger emot beslutet kastas och den regelstyrda texten visas i stället.
- **Ärlighet om osäkerhet:** inga sålda jämförelser eller inga annonser → säkerhet "låg" och tydlig flagga. Inga Tradera-träffar → säkerheten är aldrig "hög".
- **Historik** (🕘 uppe till höger eller knappen på startsidan): varje skanning sparas i telefonen (IndexedDB) med hela kortet, en miniatyr, tid och inköpspris. Filtrera på beslut och "sparad i lager", sök på namn/modellnummer, öppna ett kort som det såg ut och bläddra med pilarna eller genom att svepa. "Spara till lager" fungerar även härifrån. Historiken fungerar utan nät men finns bara i den telefonen – Sheet är den gemensamma loggen. Använd appen från hemskärmen, så rensar inte iOS historiken.
- **Annonsläge** (📦 uppe till höger eller "Fota annonser" på startsidan): fota en artikel i taget med kameran i appen (eller 📷/🖼), upp till 8 bilder där första är huvudbild (alla följer med annonsen; Lens tittar bara på huvudbilden och Gemini först bara på den – går modellen inte att fastställa används upp till 3 bilder), skriv en anteckning (skick, märke, något som saknas) och tryck *Nästa annons*. Listan visar alla annonser med antal bilder; alla är markerade från början. Tryck på en annons för att ändra den. Allt sparas i telefonen. *Skicka till AI* laddar upp de markerade annonserna till Drive (`Loppisskannern/Annonser/<id>`, bilderna delas som "alla med länken" eftersom ProLister kräver publika bilder) och lägger dem i fliken **Annonser** med status *Väntar*.
  - **Kön** körs av Apps Script: en timer startar `processQueue` varje minut så länge något väntar. Den anropar `/api/listing-process` en annons i taget (Google Lens på huvudbilden, Gemini, Tradera, annonstext enligt `prompts/tradera-annons.md`) och skriver tillbaka resultatet med status *Klar*. Appen kan vara stängd under tiden. Timern stängs av när kön är tom.
  - **Granska** under *Skickade*: tryck på rätt modellnummer (inget räknas som bekräftat utan ditt tryck; väljer du ett annat nummer berikas annonsen om), redigera rubrik, beskrivning, fast pris och kanal (Tradera som standard, Vinted för kläder/skor/väskor) och tryck *Godkänn*. Godkända annonser läggs också i fliken Lager.
  - Servern kontrollerar alltid texten: "egen samling" och liknande tas bort, raden "Kommer från rökfritt och djurfritt hem." står exakt sist och rubriken är högst 80 tecken.
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

### 2b+. Google Lens (SerpApi)
1. Skapa ett konto på <https://serpapi.com> och kopiera din API-nyckel från Dashboard.
2. Lägg in den som `SERPAPI_API_KEY` i Vercel. Ange gärna `SERPAPI_USD_PER_SEARCH` efter din plan (standard 0,015 $), så att kostnadsraden stämmer.
3. "Testa anslutning" visar hur många sökningar du har kvar.

### 2b++. Tradera API (aktiva annonser)
1. Logga in på [Tradera Developer Program](https://api.tradera.com) → Applications → din app → Keys.
2. Lägg in `TRADERA_APP_ID` (Application ID), `TRADERA_APP_KEY` (App Key) och `TRADERA_PUBLIC_KEY` (Public Key) i Vercel.
3. Skanningen söker då aktiva annonser på Tradera (märke + bekräftat modellnummer, annars namnet). Gratis inom 10 000 anrop per dygn. Annonserna väger tyngst för *Lägg ut för*; budannonser visas med "bud". Slå av under ⚙︎ om du vill.

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
