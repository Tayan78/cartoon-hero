# Databasen (Cloudflare D1)

Marknadsdatan flyttas från Google Sheet till en egen databas, **D1** (SQLite) i Cloudflare, kopplad till bevakningens worker (`worker/`, bindningen `DB`, databasen `loppis`).

## Varför
- Historiken ska sparas för alltid och fler nischer tillkomma. Arket skriver om hela fliken vid varje sparning och har ett tak på 10 miljoner celler.
- Pris per modell över tid, säljtid, konkurrenter, säsong och nya nischer kräver historik och summeringar.

## Tabeller (`worker/migrations/`)
- `sellers` – säljarna (samma fält som fliken Säljare).
- `listings` – en rad per annons (samma fält som fliken Marknad, plus `category_id`, `raw` = Traderas svar utan lång beskrivning, `source` = varifrån raden kom). Databasen räknar själv första/lägsta pris och prisändringar, och en oförändrad annons skrivs inte (sparar skrivningar). `last_seen` = senast annonsen ändrades.
- `price_history` – varje pris vi sett per annons (första priset + varje ändring).

Deploy-flödet kör nya migrationer (`wrangler d1 migrations apply loppis --remote`) innan workern deployas.

## Adresser (workern, med `x-app-token: APP_TOKEN`)
- `GET /data/status` – antal annonser, sålda, per nisch, säljare, prispunkter.
- `POST /data/listings` `{ rows }` – upsert av annonser (högst 500 per anrop). Fält som saknas skriver inte över.
- `POST /data/sellers` `{ rows }` – upsert av säljare.
- `POST /data/query` `{ statuses }` – annonser med vissa statusar (underlaget för styckpriserna).
- `POST /data/unresolved` `{ limit }` – avslutade Köp nu-annonser med okänt utfall.

Appen (Vercel) använder dem via `lib/db.js`; `DATA_URL` kan sättas i Vercel om workerns adress ändras.

## Övergången
1. ✅ Insamlingen skriver till både arket och databasen. Fel mot databasen stoppar inte arket men syns som fel på säljaren.
2. ✅ Marknadsdata → *Kopiera arket till databasen* flyttar det som redan finns (kan köras om).
3. ✅ Styckpriserna (Fynd och bevakningen) läses från databasen, med arket som reserv om databasen inte svarar.
4. ✅ Alla de bevakade säljarnas annonser sparas i databasen (alla kategorier, med Traderas rådata och kategori). Arket får bara nischerna.
5. ✅ **All Schleich på Tradera** (`lib/sweep.js`): varje natt efter säljarna hämtas alla aktiva och avslutade annonser för sökorden *schleich, bayala, eldrador* – oavsett säljare – och märks med serie (`lib/series.js`). Sökningen ger högst 2 400 träffar, så den delas upp i prisintervall (`priceMinimum`/`priceMaximum`) tills varje del ryms. Avslutade Köp nu-annonser kollas i annonsdetaljen (såld eller inte), högst 600 per natt. Status i fliken Körningar (raden *schleich*) och i appen under Marknadsdata. Provsökningen 2026-10-31: 5 072 avslutade (äldsta från nov 2023) + 2 314 aktiva.
6. Arket blir en nattlig sammanfattning.

## Serier (`lib/series.js`)
Bayala, Eldrador, Wizarding World/Harry Potter, Riddartiden, Vilda Västern, Peanuts/Snobben, Star Wars och Smurfar räknas inte som Schleich-djur (påverkar inte styckpriserna för djur). Horse Club, Wild Life, Farm World och Dinosaurs är djur. Nya serier läggs till i listan.

## Drift (översikten i appen)
Hem → **Drift** visar på ett ställe:
- **Läget** – kontroller med ✓/!/✕: bevakningen söker (senast inom 3 min), Telegram kopplat, nattens säljarinsamling och Schleich-insamlingen har körts senaste 26 h utan fel, anrop under 80 % av gränsen.
- **Körningar** – de 3 senaste per typ (tabellen `runs`, migration `0004_monitoring.sql`) och bevakningens status.
- **Anrop i dag** – per tjänst och dygn (tabellen `usage`): Tradera per metod (gräns 10 000), D1 skrivna rader (gräns 100 000), Gemini, Google Lens, Vision, Claude, notiser och fel. Appservern räknar i minnet och skickar samlat (`lib/usage.js`); bevakningen skriver var 10:e sökning; workern räknar D1:s skrivna rader.
- **Databasen** – siffror, nya annonser per dag, sålda per månad och fördelning per nisch, serie och källa.

Adresser: `GET /data/dashboard`, `POST /data/usage { counts }`, `POST /data/run { name, started_at }` → id, sedan `{ id, finished_at, status, summary }`.

## Förslag på konkurrenter
Marknadsdata → *Förslag från databasen*: säljare rankade efter sålda Schleich-annonser (rader med nisch, serie eller från Schleich-sökningen – inte bevakade säljares övriga sortiment), med sålda senaste 90 dagarna, säljgrad, medianpris och vad de mest säljer. Minst 10 annonser. **Bevaka** lägger till säljaren och samlar in hela sortimentet. Adress: `POST /data/competitors { limit, min }`.

Startsidan → *Sålt 7 dagar*: dina sålda Schleich-annonser (kontot märkt som ditt under Inköp) mot hela marknadens, med andel, intäkt och jämförelse mot veckan före, plus de fem konkurrenter som sålt flest. Räknas på status Såld och slutdatum. Adress: `POST /data/week { days }`.

## Produkter och observationer (grunden för statistik per modell)
Migration `0005_products.sql`:
- `products` – en standardiserad produkt per modellnummer, nyckel `SCHLEICH-13729`.
- `listing_products` – annons ↔ produkt (flera produkter per annons för paket), med `method` (rubrik / text / ai), `confidence` och `model_version`. En säkrare tolkning ersätter en osäkrare; rådatan i `listings` skrivs aldrig över.
- `listing_snapshots` – annonsens pris, bud och status vid varje observation där något ändrats (plus ett utgångsläge för alla befintliga annonser).
- `categories` – Traderas kategorier med namn och sökväg.

Kopplingen (`lib/products.js`): bara Schleich-annonser (schleich/bayala/eldrador/smurf), femsiffriga Schleich-nummer (inte priser eller årtal). Nummer i rubriken: säkerhet 0,95 (en produkt) eller 0,8 (flera = paket). Nummer i texten: 0,8. Annonser utan nummer kopplas senare med AI.

Varje natt efter Schleich-insamlingen kopplas annonser som saknar produkt och kategorierna uppdateras (`lib/productsync.js`). Drift → *Produkter* visar täckning och de mest sålda modellerna (priser bara från annonser med en enda produkt). Adresser: `POST /data/links`, `/data/texts`, `/data/categories`, `/data/products`.

## Lager: rådata → tolkning → beräkningar
1. **Rådata** (det Tradera-API:et ger, skrivs aldrig över av tolkningar): `listings` (inklusive `raw`, hela `description`, `start_at`, `opening_price`, `buy_now_price`, `shipping`, `image_count`, `reserve_met`) och `listing_snapshots`. Köparnas uppgifter (`maxBidder`, `buyerList`, `acceptedBuyerId`) sparas aldrig.
2. **Tolkning** (kan räknas om): `listing_products` (metod, säkerhet, version), `niche`, `series`, `model_number`.
3. **Beräkningar**: medianpris, säljgrad m.m. räknas ur 1 och 2.

## Annonsdetaljer (`lib/detail.js`, migration `0006_detail.sql`)
Sökningen ger bara rubrik och pris. Efter Schleich-insamlingen hämtas annonsdetaljen (`GET /v4/items/{id}`) för Schleich-annonser som saknar den, **nyast först**: nya annonser får full information samma natt, historiken tas med högst 2 500 per natt (700 per anrop till servern, i en kedja). Detaljen ger hela beskrivningen (reglerna letar modellnummer i den), startdatum, utropspris, Köp nu-pris, frakt, antal bilder, reservpris och verifierat utfall (`gotWinner` – även auktioner där reservpriset inte nåddes blir Osåld). En annons som inte finns kvar markeras som hämtad. Körningen syns i Drift (*Annonsdetaljer*), liksom andelen annonser med detalj.

## Marknadsanalys (Hem → Marknadsanalys)
Schleich på Tradera för vald period (7, 30, 90 dagar eller allt, räknat på slutdatum): sålda, säljgrad, medianpris, säljare; avslutade per dag/vecka (sålda och osålda); publicerade (startdatum, komplett när alla har annonsdetalj); andel sålda per slutdag och sluttimme (auktioner, timmar med minst 20 avslut); segment (sålda, säljgrad, median, utbud i månader) och aktiva annonser som slutar de kommande veckorna. Allt räknas i SQL i D1 (`worker/src/analytics.js`, `POST /data/market { days }`) – workerns gratisnivå har bara 10 ms processortid per anrop. Segmenten i SQL är en förenklad version av indelningen i appen (partier via ord som "st", "paket", "samling").

`scripts/bi-preview.mjs` (Actions → *BI-förhandsvisning*) skriver ut samma slags sammanställning för hand.

## Dina affärer: inköp (steg 1)
Migration `0007_purchases.sql`: `purchases` (inköp: datum, källa, länk, pris, frakt, avgifter, total kostnad, antal objekt, status öppen/klar, `legacy` = gammalt lager) och `own_items` (en rad per fotad annons, id = appens annons-id, kopplad till ett inköp). `sellers.own` märker ditt eget konto (samlas in men räknas inte som konkurrent).

- Hem → **Inköp**: klistra in en Tradera-länk så fylls pris, frakt (billigaste – kontrollera vad du valde), köparskydd, antal och datum i; eller fyll i för hand. *Gammalt lager* för det du sålde innan spårningen fanns (hålls utanför avkastningen).
- **Fota**: väljaren *Från inköp* – det senaste öppna inköpet är förvalt. Kopplingen sparas bara i databasen när annonsen laddas upp; arket och annonsen påverkas inte.
- **Ditt Tradera-konto** (Joulupukkin, fast i koden: `OWN_ALIAS` i `lib/purchases.js`): kopplas automatiskt när det saknas (vid Inköp, Sålt 7 dagar), bevakas och samlas in varje natt.

Steg 2: försäljningar kopplas till objekten (ditt konto), vinst/avkastning per inköp, kostnadsfördelning efter förväntat värde och restpartier.

## Prissättning ur databasen (Fota → Granska)

När en fotad Schleich-annons berikas och modellnumret är säkert (bekräftat av dig, eller verifierat via din anteckning/Lens) slås modellen upp i databasen: `POST /data/model { number }` (`worker/src/model.js`). Räknas på de senaste 4 månaderna och bara annonser med en enda figur (partier och paket bort); auktioner som inte nådde reservpriset räknas som osålda.

Priset (`marketPrice` i `lib/listing.js`):
- **Minst 3 sålda:** sålt median.
- **Mättad modell** (minst 2 till salu under medianen och under 50 % säljs): billigaste till salu, men aldrig under den undre kvartilen av vad modellen sålt för.
- **Färre än 3 sålda eller databasen nere:** som förut – billigaste på Tradera just nu.
- Lägsta pris för hästar (69 kr) och föl/ponnyer (49 kr) gäller alltid.

Granska visar rutan *"13773 i databasen"*: sålda, säljgrad, median med spann, till salu nu, tid till såld och de senast sålda.

## Ditt Tradera-konto: exakta försäljningar (migration 0008)

`app_secrets` (nyckeln till ditt konto, JSON) och `own_sales` (en rad per sålt objekt ur dina ordrar: annons-id, rubrik, antal, **pris köparen betalade**, orderns delsumma, frakt, betalt belopp och datum). Köparens namn, e-post och adress kastas innan något sparas.

Koppling (en gång, Inköp → *Koppla Tradera-konto*): appen öppnar Traderas inloggning (`token-login?appId&pkey&skey`, skey = engångsnyckel som appen skapar). Du godkänner, går tillbaka till appen, och servern hämtar nyckeln med `POST /v4/auth/token { userId, secretKey }` (`lib/traderauser.js`). Kräver `TRADERA_PUBLIC_KEY` i Vercel och att *Accept URL/Reject URL* är tomma i appens inställningar hos Tradera.

Varje natt (och med *Hämta försäljningar nu*): `GET /v4/orders` med `X-User-Id`/`X-User-Token`, från förra hämtningen minus 2 dygn (första gången 120 dygn bakåt) i 30-dagarsfönster. Drift varnar 30 dagar innan nyckeln går ut. Adress: `POST /data/own { op: auth_get | auth_set | status | sales_upsert }` – `status` och Drift visar aldrig själva nyckeln.

## Skrivbudget och nattjobbets ordning

- **Skrivbudget:** workern stoppar stora skrivningar (annonser, produktkopplingar, kategorier) när dygnets räknare `d1_rows` når 85 000 rader (`DAILY_WRITE_BUDGET`, kan sättas som variabel på workern). Svaret blir 429 med förklaring; insamlingen visar felet och fortsätter efter midnatt UTC. Små skrivningar (körningar, säljare, inköp, ditt konto, räknare) går alltid igenom.
- **Per del:** räknaren delas upp i `d1_rows_listings`, `d1_rows_snapshots`, `d1_rows_prices` och `d1_rows_links` (Drift → Anrop).
- **Ingen onödig omskrivning:** länk och alias räknas inte som ändring, och säljarinsamlingen ger samma pris som Schleich-sökningen för auktioner utan bud (nästa bud), så att en annons som hämtas från båda inte skrivs om varje natt.
- **Ordning:** `nightly` startar säljarinsamlingen och Schleich-sökningen (följd av annonsdetaljerna) parallellt – sökningen körs även om säljarinsamlingen dör. En körning som stått som *Pågår* markeras *Avbruten* när nästa av samma slag startar.
- **Kontroll:** GitHub Actions → *BI-förhandsvisning* skriver även ut driftläget ur databasen (`scripts/drift-status.mjs`, bara läsning).
