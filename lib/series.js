// Schleich-serier (även utgångna) som annonserna märks med. Märkningen är en
// tolkning av rubrik + text och kan räknas om på all historik när listan ändras.
export const SERIES = [
  { id: "bayala", label: "Bayala", re: /bayala|\bälv(a|or|orna)\b/i, animal: false },
  { id: "eldrador", label: "Eldrador", re: /eldrador/i, animal: false },
  { id: "wizarding_world", label: "Wizarding World / Harry Potter", re: /harry potter|wizarding|hogwarts|hermione|dumbledore|hagrid|voldemort|hedwig/i, animal: false },
  { id: "riddare", label: "Riddartiden", re: /riddare|riddar|knights?\b/i, animal: false },
  { id: "vilda_vastern", label: "Vilda Västern", re: /cowboy|\bindian(er|en|erna)?\b|vilda västern/i, animal: false },
  { id: "peanuts", label: "Peanuts / Snobben", re: /snobben|snoopy|peanuts|charlie brown|karl-?alfred/i, animal: false },
  { id: "star_wars", label: "Star Wars", re: /star wars|yoda|darth|stormtrooper/i, animal: false },
  { id: "smurfar", label: "Smurfar", re: /smurf|smölf/i, animal: false },
  { id: "horse_club", label: "Horse Club", re: /horse club/i, animal: true },
  { id: "wild_life", label: "Wild Life", re: /wild ?life/i, animal: true },
  { id: "farm_world", label: "Farm World", re: /farm ?world/i, animal: true },
  { id: "dinosaurs", label: "Dinosaurs", re: /dinosaur|dinosaurie|\bdino\b|t-?rex/i, animal: true },
];

// Serierna en annons hör till, kommaseparerat (t.ex. "bayala"), eller null.
export function seriesOf(text) {
  const t = String(text ?? "");
  const ids = SERIES.filter((s) => s.re.test(t)).map((s) => s.id);
  return ids.length ? ids.join(",") : null;
}

// Schleich-serier som inte är djur (fantasy, figurer från film och serier).
export const NON_ANIMAL = new RegExp(SERIES.filter((s) => !s.animal).map((s) => s.re.source).join("|"), "i");
