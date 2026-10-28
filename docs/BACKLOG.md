# Backlog – Loppisskannern

Saker vi har pratat om men som **inte** finns i Alpha v1 ([ALPHA-v1.md](ALPHA-v1.md)). Ordningen inom varje grupp är ett förslag. Prioritera efter veckans skarpa test.

**Prioritet:** 🔴 viktigt efter testet · 🟡 bra att ha · ⚪ senare/idé
**Status:** *Väntar på test* = beror på vad det skarpa testet visar

---

## A. Verifiera efter det skarpa testet

| | Punkt | Bakgrund |
|---|---|---|
| 🔴 | **Träffsäkerhet för Schleich** | Första testet: 4 av 23 behövde ett annat modellnummer. Mät också ras/djurtyp och årtal över fler batcher, och justera prompten (`listing_name`, `production_years`) eller lägg till fler kandidater. |
| 🔴 | **Bilder från bildbiblioteket** | Rättat i #27 (mindre avkodning, minnet släpps). Testa 8 bilder per annons på nästa batch. *Väntar på test* |
| 🟡 | **Mapp med klockslag** | Två exporter samma dag hamnar i samma mapp. Alternativ: `2026-10-25 14.30 Schleich`. |
| 🟡 | **Fel i kön** | Gör annonser med status *Fel* ett automatiskt nytt försök (t.ex. en gång efter 10 minuter) innan du behöver trycka själv? |

## B. Pris och köpbeslut

| | Punkt | Bakgrund |
|---|---|---|
| 🔴 | **Sålda priser per modellnummer** | Traderas avancerade sökning med `itemStatus: "Ended"` ger avslutade annonser ca 4 månader bakåt (verifierat för Lego i #31–#32). Sök "schleich <nummer>": median, spann och säljgrad (andel auktioner med bud) i Skanna och annonsläget, i stället för lägsta aktiva pris. Sedan en topplista över vilka modeller som säljer bäst och dyrast. |
| 🟡 | **Ange inköpspris efter skanningen** | Skriv in priset på kortet och få beslutet omräknat, utan en ny skanning. Det kostar inget, eftersom servern bara räknar om. |
| 🟡 | **Kandidatknappar för modellnummer i skanningen** | Finns i annonsläget men inte i skanningen. Rätt nummer ger rätt priser. |
| 🟡 | **Påslag på utpriset** | T.ex. "Lägg ut för" + 10 % för att ge prutmån. Avvaktat, eftersom du valde exakt lägsta pris. |
| ⚪ | **eBay Browse API** | Riktiga aktiva eBay-annonser i stället för bara det Lens råkar hitta. Kräver ett utvecklarkonto. |
| ⚪ | **Fler småfigursmärken** | Papo, Bullyland, Collecta … Listan finns redan i köpreglerna, men standard är bara Schleich. |

## C. Annonsläget

| | Punkt | Bakgrund |
|---|---|---|
| 🟡 | **Egen bilddatabas för modellnummer** | Godkända annonser (huvudbild + bekräftat nummer) blir referenser. Varje bild görs om till en embedding (t.ex. Vertex AI multimodal embeddings), ny bild jämförs mot alla, och Gemini kontrollerar de 3 närmaste. **Mät först:** sök varje bekräftad bild mot de andra och räkna hur ofta rätt nummer kommer först. Bygg bara vidare om appen har rätt i minst 95 % av fallen där den säger sig vara säker; annars tar Lens över som i dag. Kräver Vertex AI och en nyckel för ett tjänstekonto i Vercel. Känner bara igen modeller du redan fotat. Svårast: samma form i olika färg. |
| 🟡 | **"Skapa annons" från historik och lager** | Ett kort från en skanning, eller en rad i Lager, ska kunna bli en annons utan att du fotar igen. (Ursprungligen planerat för PR B/C.) |
| 🟡 | **Prompt för fler kategorier** | Bara Schleich har fast mall. Mallar för t.ex. porslin och andra leksaksmärken när du börjar sälja det. |
| 🟡 | **Kanalregel efter data** | I dag: Tradera som standard, Vinted för kläder, skor och väskor. Föreslå gränser utifrån Sheet när det finns mer data. |
| ⚪ | **Vinted-export** | Vinted saknar import. I dag finns "Kopiera rubrik och text". |
| ⚪ | **Ordning och huvudbild** | Byt ordning på bilder och välj huvudbild i efterhand. I dag är bild 1 alltid huvudbild. |
| ⚪ | **Mappar per serie** | Alternativ B/C från diskussionen om mappar: `Schleich Hästar 2026-10` osv. Valdes bort till förmån för datum + typ. |

## D. Tradera direkt (fas 4)

| | Punkt | Bakgrund |
|---|---|---|
| ⚪ | **Publicera direkt via Traderas API** | `AddItem`, `AddItemImage` och `AddItemCommit` i stället för ProLister-filen. Kräver användartoken (token-login), Accept/Reject Return URL på Tradera-sidan och `TRADERA_PUBLIC_KEY` (redan i Vercel). |
| ⚪ | **Status såld** | Hämta sålda objekt (`GetSellerTransactions`/`GetSellerItems`) och markera dem som sålda i Lager. Visa faktisk vinst per figur. |
| ⚪ | **Omstart och prissänkning** | Föreslå sänkt pris eller omstart för annonser som legat ute länge. |

## E. Kostnad och drift

| | Punkt | Bakgrund |
|---|---|---|
| 🟡 | **Gemini utan Google-sökning när Lens finns** | Gemini har sökning påslagen även när Lens redan gett träffar, vilket kan kosta extra per anrop. Stäng av den i Lens-läget om träffsäkerheten håller. |
| ⚪ | **Tydligare varning för Lens-kvoten** | Kvoten visas på startsidan och mätaren blir gul/röd. Kvar: en varning i själva skanningen när det är få sökningar kvar. |
| 🟡 | **Kostnadsöversikt** | Saldot för Google Cloud visas på startsidan. Kvar: summa per vecka och månad, och per annons, från Sheet. |
| ⚪ | **Förenkla: ta bort avancerat läge (Claude)** | Används inte längre i praktiken. Mindre kod och färre inställningar. |
| ⚪ | **Vision-ledtråd** | Använd Visions "visuellt liknande bilder" (domäner som schleich-s.com) som märkesledtråd när Lens saknas. |
| ⚪ | **Städa Drive** | Ta bort bilder för sålda eller raderade annonser efter en tid. |

## F. App och användning

| | Punkt | Bakgrund |
|---|---|---|
| 🟡 | **Historik på flera enheter** | Historiken och ej skickade annonser finns bara i telefonen. De kan synkas via Sheet. |
| ⚪ | **Kamerakvalitet** | Utvärdera kameran i appen mot iPhones egen kamera. Eventuellt en inställning för vilken som ska vara standard. |
| ⚪ | **Ta bort `test.html`** | Gammal fil från repots början, används inte av appen. |

## G. Säkerhet

| | Punkt | Bakgrund |
|---|---|---|
| 🟡 | **Byt Tradera App Key** | Nyckeln syntes i en skärmdump. Skapa en ny applikation hos Tradera och byt `TRADERA_APP_KEY` i Vercel. |
| ⚪ | **Bildproxyn** | `/bild/<id>.jpg` visar bara bilder som redan är delade publikt i Drive. Ett alternativ är att begränsa den till annonsernas egna bilder. |

---

## Från första skarpa testet (23 annonser)

- ✅ Kameran i appen är snabb.
- ✅ Import i ProLister: inga fel.
- ✅ 4 av 23 behövde ett annat modellnummer, vilket kandidatknapparna löste.
- **Rättat:** bilder från bildbiblioteket var långsamma, kraschade och tömde batteriet. De avkodas nu i mindre storlek, och bildminnet släpps direkt.
- **Byggt:** *Godkänn markerade*, för att godkänna alla klara annonser på en gång.
- **Byggt efteråt:** startsida med Lens-kvot, Google Cloud-saldo och antal publicerade annonser, plus en tillbaka-pil (#28).

## Klart (för spårbarhet)

Punkter från tidigare diskussioner som nu är byggda: startsida med budget och mått, ProLister-import verifierad (frakt, mapp, bilder), godkänn flera på en gång, köpbeslut med regler (PR A), historik (PR B), annonsläge C1–C3, 8 bilder per annons, bakgrundsuppladdning, Schleich-mall, egen avslutning, ProLister-export med `skick` och `Mapp`, Tradera-sökning, Lens med Vision som reserv.
