-- Rådata från annonsdetaljen (GET /v4/items/{id}) för alla Schleich-annonser:
-- hela beskrivningen, utropspris, Köp nu-pris, antal bilder och om reservpriset
-- nåddes. detail_at = när detaljen hämtades (NULL = inte hämtad än).
ALTER TABLE listings ADD COLUMN description TEXT;
ALTER TABLE listings ADD COLUMN detail_at TEXT;
ALTER TABLE listings ADD COLUMN opening_price INTEGER;
ALTER TABLE listings ADD COLUMN buy_now_price INTEGER;
ALTER TABLE listings ADD COLUMN image_count INTEGER;
ALTER TABLE listings ADD COLUMN reserve_met INTEGER;  -- 1/0, NULL = inget reservpris
