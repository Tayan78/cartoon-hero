// När en annons faktiskt slutade/såldes. Butiksannonser (och Köp nu som köps
// före slutdatumet) har ett planerat slutdatum långt fram – ibland år 2045 –
// så för sålda annonser vars slutdatum ligger efter att vi såg dem sålda
// används den tidpunkten i stället.
export const soldAt = (a = "") =>
  `(CASE WHEN ${a}status = 'Såld' AND ${a}sold_seen IS NOT NULL AND julianday(${a}end_at) > julianday(${a}sold_seen) + 1 THEN ${a}sold_seen ELSE ${a}end_at END)`;
