# Backlog – Loppisskannern

Saker vi har pratat om men som **inte** finns i Alpha v1 ([ALPHA-v1.md](ALPHA-v1.md)). Ordningen inom varje grupp är ett förslag. Prioritera efter veckans skarpa test.

**Prioritet:** 🔴 viktigt efter testet · 🟡 bra att ha · ⚪ senare/idé
**Status:** *Väntar på test* = beror på vad det skarpa testet visar

---

## A. Verifiera efter det skarpa testet

| | Punkt | Bakgrund |
|---|---|---|
| 🔴 | **Frakt i ProLister-importen** | Kolumnen `shipping` med sex fraktsätt kommer från ProListers egen export, men importguiden nämner bara `ShippingFirst`/`ShippingSecond`. Mappas den inte lägger vi de två viktigaste fraktsätten där i stället. *Väntar på test* |
| 🔴 | **Mapp och bilder i ProLister** | Kontrollera att `Mapp` skapar mappen och att `/bild/<id>.jpg` hämtas. Fungerar inte bilderna är alternativet att lagra dem i Vercel Blob, där adresserna slutar på `.jpg`. *Väntar på test* |
| 🔴 | **Träffsäkerhet för Schleich** | Mät andelen rätt modellnummer, ras/djurtyp och årtal. Justera prompten (`listing_name`, `production_years`) eller lägg till fler kandidater. *Väntar på test* |
| 🟡 | **Mapp med klockslag** | Två exporter samma dag hamnar i samma mapp. Alternativ: `2026-10-25 14.30 Schleich`. |
| 🟡 | **Fel i kön** | Gör annonser med status *Fel* ett automatiskt nytt försök (t.ex. en gång efter 10 minuter) innan du behöver trycka själv? |

## B. Pris och köpbeslut

| | Punkt | Bakgrund |
|---|---|---|
| 🔴 | **Sålda priser som budgräns** | Tradera-annonser som Lens hittar och som avslutats med bud visas redan som *sålda*. Använd dem som "Bud ned till" och i köpbeslutet när det finns tillräckligt många. |
| 🟡 | **Ange inköpspris efter skanningen** | Skriv in priset på kortet och få beslutet omräknat, utan en ny skanning. Det kostar inget, eftersom servern bara räknar om. |
| 🟡 | **Kandidatknappar för modellnummer i skanningen** | Finns i annonsläget men inte i skanningen. Rätt nummer ger rätt priser. |
| 🟡 | **Påslag på utpriset** | T.ex. "Lägg ut för" + 10 % för att ge prutmån. Avvaktat, eftersom du valde exakt lägsta pris. |
| ⚪ | **eBay Browse API** | Riktiga aktiva eBay-annonser i stället för bara det Lens råkar hitta. Kräver ett utvecklarkonto. |
| ⚪ | **Fler småfigursmärken** | Papo, Bullyland, Collecta … Listan finns redan i köpreglerna, men standard är bara Schleich. |

## C. Annonsläget

| | Punkt | Bakgrund |
|---|---|---|
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
| 🟡 | **Varning för Lens-kvoten** | Visa hur många av de 250 sökningarna som är kvar, och varna när de börjar ta slut. Uppgiften finns redan i "Testa anslutning". |
| 🟡 | **Kostnadsöversikt** | Summa per vecka och månad, och per annons, från Sheet, i appen. |
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

## Klart (för spårbarhet)

Punkter från tidigare diskussioner som nu är byggda: godkänn flera på en gång, köpbeslut med regler (PR A), historik (PR B), annonsläge C1–C3, 8 bilder per annons, bakgrundsuppladdning, Schleich-mall, egen avslutning, ProLister-export med `skick` och `Mapp`, Tradera-sökning, Lens med Vision som reserv.
