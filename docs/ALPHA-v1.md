# Loppisskannern – Alpha v1

**Status per 2026-10-26.** Allt nedan är byggt, mergat till `master` (PR #1–#28) och driftsatt på Vercel. Det första skarpa testet är gjort: 23 Schleich-annonser exporterades till ProLister utan importfel, och 4 av 23 behövde ett annat modellnummer. Rättningarna från testet (bilder från bildbiblioteket, *Godkänn markerade*) och startsidan ingår.

Det som inte är byggt än finns i [BACKLOG.md](BACKLOG.md).

---

## 1. Vad appen gör

En privat app (PWA) på iPhonen med två flöden:

| Flöde | När | Vad du får |
|---|---|---|
| **Skanna** | På loppis, innan du köper | Vad föremålet är, vad det säljs för just nu, och ett köpbeslut: **Köp / Tveksamt / Låt bli**, eller "Betala inte mer än X kr" |
| **Annonsläge** 📦 | Hemma, med det du redan köpt | Färdiga annonser (rubrik, text, pris, bilder) som du granskar och exporterar till Tradera ProLister |

Dessutom finns:
- **Historik** 🕘: alla skanningar sparas i telefonen.
- **Google Sheet**: logg över allt, plus flikarna Lager och Annonser.


**Startsidan** är det första du ser när appen öppnas. Den har knappar till alla delar (Skanna, Fota annonser, Annonser, Historik, Inställningar) och tre mått som hämtas varje gång du kommer tillbaka till den:
- **Google Lens:** sökningar kvar hos SerpApi av 250, hämtas live. Mätaren blir gul och sedan röd när kvoten börjar ta slut.
- **Google Cloud:** saldo kvar. Det räknas från din senaste avläsning i Google Cloud (⚙︎ → Budget) plus appens egen kostnadsräkning sedan dess, eftersom Google inte visar saldot via API.
- **Publicerade via appen:** antal annonser med status *Exporterad* i fliken Annonser. Under siffran visas hur många som är klara eller godkända men inte exporterade än.

Alla andra vyer har en **tillbaka-pil** (←) högst upp.
---

## 2. Teknik i korthet

```
iPhone (PWA, vanilla JS)
   │  fota → komprimera (≤1500 px, ≤480 kB) → IndexedDB (historik, annonsgrupper)
   ▼
Vercel (Node, serverless)                         Google Apps Script (Sheet + Drive)
   /api/scan            skanning (strömmar svar)      Skanningar · Lager · Annonser (flikar)
   /api/listings        annonsläget (upp/list/…)      Drive: Loppisskannern/Skanningar
   /api/listing-process berikning (anropas av kön) ◀── kön: processQueue var 60 s
   /api/image           /bild/<id>.jpg för ProLister  Drive: Loppisskannern/Annonser, /Export
   /api/save, /api/ping
   │
   ├─ SerpApi Google Lens   bildsök på huvudbilden (svenska träffar, priser)
   ├─ Google Cloud Vision   reserv om Lens misslyckas
   ├─ Gemini (Flash)        identifiering, motivering, brist-mening, annonstext
   ├─ Tradera REST API v4   aktiva annonser + pris för Lens-träffarnas Tradera-länkar
   └─ Claude (Anthropic)    bara i "avancerat läge" (valfritt, används normalt inte)
```

| Del | Var |
|---|---|
| App (skal, vyer, kamera) | `public/index.html`, `public/app.js`, `public/styles.css`, `public/sw.js` |
| Lagring i telefonen | `public/history.js` (IndexedDB: `scans`, `groups`) |
| Skanning | `api/scan.js` → `lib/lens.js`, `lib/simple.js`, `lib/gemini.js`, `lib/tradera.js`, `lib/economics.js`, `lib/decision.js` |
| Annonsläget | `api/listings.js`, `api/listing-process.js`, `lib/listing.js`, `prompts/tradera-annons.md` |
| ProLister-export | `lib/prolister.js`, `api/image.js` |
| Sheet/Drive/kö | `apps-script/Code.gs` |
| Inställningar (server) | `lib/settings.js` |
| Tester | `test/*.test.js` (83 st, `npm test`), mockläge `npm run dev:mock` |

---

## 3. Flöde: Skanna (köpbeslut på loppis)

1. **Fota** 1–4 vinklar (kamera eller bildval). Du kan ange **inköpspris** och **info** (märke, storlek, skick …), men båda är valfria.
2. **Google Lens** söker på huvudbilden som i Sverige (`hl=sv`, `country=se`). Misslyckas Lens, t.ex. när månadens 250 gratissökningar är slut, tar **Cloud Vision** över.
3. **Gemini** identifierar föremålet utifrån bilderna och Lens-träffarna: namn, märke, modellnummer, ålder och skick.
   - Ett **modellnummer räknas som bekräftat** bara om det står i din info, i Lens-titlarna eller i bildsökets träffar.
4. **Tradera:** appen söker aktiva annonser med märke + nummer, och annars med namnet. Den hämtar också priset för Tradera-annonser som Lens hittat via bilden, max 5 stycken. Lotter och andra modellnummer sorteras bort.
5. **Pris:**
   - **"Lägg ut för"** = lägsta pris för begagnat på Tradera eller eBay, annars lägsta annons, annars en uppskattning.
   - **Nypris i butik** visas separat och räknas aldrig som begagnatpris.
   - Sålda priser söks inte längre i enkelt läge.
6. **Köpbeslutet räknas av servern**, aldrig av AI:n (`lib/decision.js`):
   - **Vinst** = netto efter avgift och frakt − inköp. **Multipel** = netto / inköp.
   - **Vanliga föremål:**
     - **Köp:** vinst ≥ 100 kr och (multipel ≥ 2,0 eller inköp ≥ 200 kr)
     - **Tveksamt:** vinst > 0
     - **Låt bli:** annars
   - **Småfigurer** (allt från Schleich, eller utpris < 100 kr):
     - **Köp:** från 2,0×
     - **Tveksamt:** från 1,3×
     - **Låt bli:** under 1,3×
     - Kortet påminner om att räkna på hela lotten.
   - **Osäkert pris** (låg säkerhet, eller inga annonser från Tradera/eBay) ger högst Tveksamt.
   - **Utan inköpspris** räknas maxpriset bakvägen: "Betala inte mer än X kr".
   - Alla trösklar ändras under ⚙︎ → Köpregler.
7. **Motivering:** Gemini får det färdiga beslutet och skriver en mening om det. Säger meningen emot beslutet kastas den, och en fast regeltext visas i stället.
8. **Loggas** i Sheet (fliken Skanningar, med huvudbilden i Drive) och sparas i **Historiken**. Därifrån kan du **Spara till lager**.

Kortet visar: prispanel (lägg ut för, mittpris, prislinje, antal annonser), beslut i färg med vinst och multipel, källor, sökknappar till Tradera/eBay/Blocket/Vinted, kostnad per steg och "Visa rådata".

---

## 4. Flöde: Annonsläge (hemma, till ProLister)

### 4.1 Fota
- 📦 → **Fota annonser**. Kameran är inbyggd i appen, med 📷 (iPhones kamera) och 🖼 (bildval) som reserv.
- **1–8 bilder per annons.** Bild 1 är alltid **huvudbild**.
- **Anteckning** per annons, t.ex. "saknar svans".
- **Nästa annons →** sparar annonsen och börjar om.
- Allt sparas i telefonen. Varje annons **laddas upp i bakgrunden** medan du fotar nästa.
  - Avbrott (skärmen släcks, ingen täckning) fortsätter av sig självt när appen är öppen igen.
  - Nätverksfel provas om automatiskt.
  - Skärmen hålls tänd under uppladdningen, där iPhonen stöder det.

### 4.2 Skicka till AI
- Listan visar alla annonser (alla markerade från början) med status ☁︎ uppladdad, ⏫ laddar upp eller ⏳ väntar på nät.
- **Skicka till AI** lägger de uppladdade annonserna i kön i fliken *Annonser* och tar bara någon sekund. Sedan **kan appen stängas**.
- **Kön** (Apps Script, en timer var 60:e sekund medan något väntar) skickar en annons i taget till `/api/listing-process`:
  1. **Google Lens** på **huvudbilden**.
  2. **Gemini** med huvudbilden. Om modellen inte går att fastställa görs ett nytt försök med **upp till 3 bilder**.
  3. **Tradera**: priser, på samma sätt som i skanningen.
  4. **Text:**
     - **Schleich** följer en **fast mall**. Rubrik: *Schleich + ras + djurtyp + modellnummer + (årtal)*, t.ex. "Schleich Tinker sto 13279 (2003-08)". Text: *rubriken + "i lekt men bra skick enligt bild."*, plus en mening om brister om din anteckning handlar om skicket. Årtalet tas bara med när det har hittats i källorna.
     - **Övrigt** skrivs av AI:n enligt `prompts/tradera-annons.md`.
     - **Din fasta avslutning** (⚙︎ → Annonser) läggs alltid sist.
  5. **Kontroll av servern:**
     - "egen samling" och "rökfritt/djurfritt hem" tas alltid bort
     - rubriken är högst 80 tecken
  6. **Kanal:** Tradera som standard, Vinted för kläder, skor och väskor.
- Räkna med ungefär 1 annons per minut. Status: *Väntar → Bearbetas → Klar* (eller *Fel*, med knappen Försök igen).

### 4.3 Granska
- Under **Skickade**:
  - **Tryck på rätt modellnummer.** Kandidaterna kommer från Gemini och Lens. **Inget nummer räknas som bekräftat utan ditt tryck**, och väljer du ett annat nummer berikas annonsen om. Det går också att skriva ett eget nummer.
  - Redigera rubrik, text, fast pris och kanal. Under "Jämförelser" syns annonserna som priset bygger på.
  - **Godkänn.** Annonsen läggs också i fliken **Lager**.
  - **Godkänn markerade:** alla klara annonser är förbockade. Avmarkera de du vill vänta med och godkänn resten på en gång. Modellnumret AI:n valt räknas då som bekräftat, så rätta de felaktiga först.
  - Det finns knappar för **Kopiera rubrik och text** (för Vinted) och **Ta bort** (raderar även bilderna i Drive).

### 4.4 Exportera till ProLister
- **📄 Exportera till ProLister (N)** gör en CSV-fil av alla **godkända Tradera-annonser**:
  - Exakt samma format som ProListers egen export: 31 kolumner, UTF-8 med BOM, `;`, alla fält inom citattecken och `<br>` för radbrytningar.
  - **Fast pris i 30 dagar.**
  - **För Schleich:** kategori `1000532 : Miniatyrer & leksaksfigurer`, **`skick` = Gott skick** och dina **sex fraktsätt**. Alla tre ändras under ⚙︎ → Annonser.
  - **Bilder:** `https://<appen>/bild/<drive-id>.jpg`. Appen hämtar dem från Drive.
  - **Mapp:** `ÅÅÅÅ-MM-DD Schleich` / `ÅÅÅÅ-MM-DD Övrigt`.
  - **Referens:** annonsens id i Sheet.
- Filen sparas i Drive under `Loppisskannern/Export` och kan sparas eller delas från telefonen.
- Annonser som saknar rubrik, text, pris eller bilder, eller har förbjudna formuleringar, tas inte med. Appen säger vilka och varför.
- Exporterade annonser markeras *Exporterad* och följer bara med igen om du kryssar i "Ta med redan exporterade".

---

## 5. Konfiguration

### 5.1 Vercel → Settings → Environment Variables

| Namn | Används till | Krävs |
|---|---|---|
| `APP_TOKEN` | appens lösenord | ja |
| `APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET` | Sheet/Drive och kön (samma hemlighet som `SECRET` i Apps Script) | ja |
| `GEMINI_API_KEY` | identifiering och texter | ja |
| `SERPAPI_API_KEY` | Google Lens | ja (annars Vision) |
| `SERPAPI_USD_PER_SEARCH` | kostnadsraden (`0` på gratisplanen) | nej |
| `TRADERA_APP_ID`, `TRADERA_APP_KEY` | Traderas sökning | ja |
| `TRADERA_PUBLIC_KEY` | reserverad för inloggning/publicering direkt (se backloggen) | nej |
| `GOOGLE_VISION_API_KEY` | reserv för bildsök | rekommenderas |
| `ANTHROPIC_API_KEY` | bara avancerat läge | nej |

Efter en ändrad variabel: **Deployments → Redeploy**. Efter en merge deployar Vercel av sig självt.

### 5.2 Google Apps Script
- Koden finns i `apps-script/Code.gs`.
- **Efter en ny version:** klistra in koden → **Save** → **Deploy → Manage deployments → ✏️ → New version → Deploy**. Välj aldrig *New deployment*, eftersom URL:en då ändras.
- **`setup`** körs en gång från editorn för att ge behörigheter (dela bilder, timer, anrop till Vercel).
- **Skriptegenskaper:**
  - `SECRET` sätts av dig.
  - `PROCESS_URL` och `QUEUE_BUSY_UNTIL` sätts av skriptet.
- **Funktioner som appen anropar** (utöver loggningen): `addListing`, `addListingImage`, `commitListing`, `listListings`, `updateListing`, `approveListings` (Godkänn markerade), `requeueListing`, `deleteListing`, `saveExport` och `summary` (siffrorna till startsidan).
- **Flikar:**
  - **Skanningar:** alla skanningar, 48 kolumner med beslut, vinst och kostnad.
  - **Lager:** "Spara till lager" och godkända annonser.
  - **Annonser:** kön och resultaten, med status och JSON.

### 5.3 Inställningar i appen (⚙︎)
Allt sparas i telefonen och skickas med varje anrop:
- lösenord
- läge (enkelt/avancerat)
- Lens/Tradera/Vision/Gemini av och på
- avgifter och frakt per plattform
- växelkurser
- köpregler
- fast avslutning i annonser
- ProLister-standard för Schleich (kategori, skick, frakt)
- **Budget:** Google Cloud-saldot och vad som är förbrukat, avläst i Google Cloud Console. Tidpunkten sparas när du ändrar *förbrukat*, och startsidan räknar sedan av appens egen kostnad från den tidpunkten.

---

## 6. Kostnad (uppskattning, exakta siffror loggas per skanning i Sheet)

| | Per styck |
|---|---|
| Skanning (Lens + Gemini + motivering, Tradera gratis) | ca **0,1–0,4 kr**. Lens är gratis inom 250/mån, därefter ca 0,16 kr via SerpApi eller Vision ca 0,04 kr |
| Annons (Lens + Gemini, ev. fler bilder, brist-mening) | ca **0,1–0,4 kr** + 1 Lens-sökning |
| Tradera API | gratis (10 000 anrop/dygn) |
| Drive | ca 0,4 MB per bild. 15 GB gratis räcker till ungefär 35 000 bilder |

**Obs:** Lens-kvoten på 250 sökningar per månad delas mellan skanningar och annonser.

---

## 7. Kända begränsningar i Alpha v1

- **ProLister-importen är verifierad** i det första skarpa testet (23 annonser, inga fel): bilder, `skick`, frakt och `Mapp`.
- **Google Cloud-saldot på startsidan är en uppskattning.** Google visar inte saldot via API, så appen räknar från din senaste avläsning. Läs av i Google Cloud Console ibland och skriv in det under ⚙︎ → Budget.
- **SerpApi visar inte när kvoten nollställs**, bara hur många sökningar som är kvar.
- **iOS stoppar webbappar som är stängda.** Uppladdning som inte hunnit klart fortsätter först när appen öppnas igen. AI-kön på servern påverkas inte.
- **Historiken och ej skickade annonser finns bara i den telefon de skapades i.** Sheet är den gemensamma loggen.
- **Inget riktigt "sålt pris" i skanningen.** Priset bygger på aktiva annonser. Tradera-annonser som Lens hittar och som har avslutats med bud visas som sålda, men används inte i beslutet.
- **Årtal och "ras + djurtyp"** i Schleich-rubriken kommer från Gemini och kan vara fel. Kontrollera i granskningen.
- **Gemini har Google-sökning påslagen även när Lens finns**, vilket kan kosta lite extra per anrop (se backloggen).
- **Kameran i appen** ger något lägre bildkvalitet än iPhones egen kamera. iOS kan fråga om kameratillstånd varje gång appen öppnas från hemskärmen.

---

## 8. Testplan för veckan (skarpt läge)

**Före start**
- [ ] Senaste `Code.gs` inklistrad och *New version* driftsatt. ⚙︎ → **Testa anslutning**: alla rader ✓ (Gemini, Lens, Tradera, Sheet).
- [ ] ⚙︎ → Annonser: kontrollera avslutningen, Schleich-kategori, skick och frakt.

**Under fotograferingen**
- [ ] Fota 10–20 Schleich-figurer, gärna både vanliga och utgångna.
- [ ] Huvudbilden: hela figuren från sidan, ljus bakgrund. Extra bilder: stämpeln under magen/foten och eventuella skador.
- [ ] Skriv en anteckning när något saknas eller är skadat.
- [ ] Kontrollera att listan visar ☁︎ på alla innan du trycker **Skicka till AI**.

**Efter berikningen** (anteckna per annons)
- [ ] Var rätt modellnummer förvalt? Fanns rätt nummer bland kandidaterna?
- [ ] Stämde ras, djurtyp och årtal i rubriken?
- [ ] Rimligt pris? Hur många Tradera-jämförelser fanns?
- [ ] Hur många gick till *Fel*, och med vilket meddelande?
- [ ] Kostnad per annons (kolumnen *Kostnad SEK* i fliken Annonser).

**Export**
- [ ] Exportera och importera i ProLister. Kom bilder, kategori, skick, frakt och mapp med?
- [ ] Skicka gärna en ny ProLister-export av de importerade annonserna, så kan jag jämföra.

Skicka "Visa rådata", eller raden i fliken Annonser, för de annonser där något blev fel.

---

## 9. Historik (PR)

| PR | Innehåll |
|---|---|
| #1–#12 | Fas 1 och vidareutveckling: snabbskanning (PWA + Vercel + Apps Script), billigare skanning med bildsök, flera vinklar, välj bilder från telefonen, modellnummer först, Gemini med Google-sökning och reservmodeller, Testa anslutning, modellnummer på kortet och i Sheet, prispanel (variant A), info-fält, enkelt läge |
| #13 | Google Lens via SerpApi |
| #14–#15 | Köpbeslut med fasta regler (grön/gul/röd, vinst, multipel), Traderas API |
| #16–#17 | Rättningar från riktig Lens-data (valuta, nypris, Tradera-namnsökning), pris för Lens-träffarnas Tradera-annonser |
| #18 | Historik över skanningar |
| #19–#20 | Annonsläge C1 (fota i grupper) och C2 (AI-kö i bakgrunden, granskning) |
| #21 | 8 bilder per annons, fast Schleich-mall, egen avslutning |
| #22 | Uppladdning i bakgrunden medan du fotar |
| #23–#25 | C3: export till ProLister, samma format som ProListers egen export, `skick`, `Mapp` |
| #26 | Dokumentation: Alpha v1 och backlog |
| #27 | Rättningar från första skarpa testet: snabbare och stabilare bilder från bildbiblioteket, *Godkänn markerade* |
| #28 | Startsida med Lens-kvot, Google Cloud-saldo och antal publicerade annonser, tillbaka-pil, budget i inställningarna |
