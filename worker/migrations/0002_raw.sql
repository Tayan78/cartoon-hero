-- Allt från säljarna (inte bara nischerna): Traderas rådata och varifrån raden kom.
ALTER TABLE listings ADD COLUMN raw TEXT;      -- Traderas svar (utan lång beskrivning)
ALTER TABLE listings ADD COLUMN source TEXT;   -- säljare / sök / bevakning
CREATE INDEX IF NOT EXISTS listings_category ON listings (category_id);
