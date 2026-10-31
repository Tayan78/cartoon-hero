# Databasen (Cloudflare D1)

Marknadsdatan flyttas från Google Sheet till en egen databas, **D1** (SQLite) i Cloudflare, kopplad till bevakningens worker (`worker/`, bindningen `DB`, databasen `loppis`).

## Varför
- Historiken ska sparas för alltid och fler nischer tillkomma. Arket skriver om hela fliken vid varje sparning och har ett tak på 10 miljoner celler.
- Pris per modell över tid, säljtid, konkurrenter, säsong och nya nischer kräver historik och summeringar.

## Tabeller (`worker/migrations/`)
- `sellers` – säljarna (samma fält som fliken Säljare).
- `listings` – en rad per annons (samma fält som fliken Marknad, plus `category_id`).
- `price_history` – varje pris vi sett per annons (första priset + varje ändring).

Deploy-flödet kör nya migrationer (`wrangler d1 migrations apply loppis --remote`) innan workern deployas.

## Adresser (workern, med `x-app-token: APP_TOKEN`)
- `GET /data/status` – antal annonser, sålda, per nisch, säljare, prispunkter.
- `POST /data/listings` `{ rows }` – upsert av annonser (högst 500 per anrop). Fält som saknas skriver inte över.
- `POST /data/sellers` `{ rows }` – upsert av säljare.
- `POST /data/query` `{ statuses }` – annonser med vissa statusar (underlaget för styckpriserna).

Appen (Vercel) använder dem via `lib/db.js`; `DATA_URL` kan sättas i Vercel om workerns adress ändras.

## Övergången
1. ✅ Insamlingen skriver till både arket och databasen. Fel mot databasen stoppar inte arket men syns som fel på säljaren.
2. ✅ Marknadsdata → *Kopiera arket till databasen* flyttar det som redan finns (kan köras om).
3. ✅ Styckpriserna (Fynd och bevakningen) läses från databasen, med arket som reserv om databasen inte svarar.
4. Spara alla säljarnas annonser, inte bara nischerna – underlag för nya nischer.
5. Arket blir en nattlig sammanfattning.
