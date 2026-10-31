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
