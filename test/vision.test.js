import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, visionText } from "../lib/vision.js";

test("slår ihop bildsöksträffar från flera bilder", () => {
  const s = summarize([
    {
      webDetection: {
        bestGuessLabels: [{ label: "rörstrand mon amie" }],
        webEntities: [{ description: "Rörstrand", score: 0.7 }, { description: "Porslin", score: 0.4 }],
        pagesWithMatchingImages: [{ url: "https://a.se/1", pageTitle: "<b>Mon Amie</b> kopp", partialMatchingImages: [{}] }],
      },
    },
    {
      webDetection: {
        webEntities: [{ description: "Rörstrand", score: 0.9 }],
        pagesWithMatchingImages: [
          { url: "https://www.tradera.com/item/1", pageTitle: "Mon Amie fat", fullMatchingImages: [{}] },
          { url: "https://a.se/1", pageTitle: "dubblett" },
        ],
      },
    },
  ]);
  assert.deepEqual(s.best_guesses, ["rörstrand mon amie"]);
  assert.deepEqual(s.entities[0], { description: "Rörstrand", score: 0.9 });
  assert.equal(s.pages.length, 2);
  assert.equal(s.pages[0].exact, true); // exakta träffar först
  assert.equal(s.pages[1].title, "Mon Amie kopp"); // HTML borttagen
  assert.match(visionText(s), /\[exakt\] Mon Amie fat/);
});

test("inga träffar → null", () => {
  assert.equal(summarize([{}, { webDetection: {} }]), null);
  assert.equal(visionText(null), "Bildsök: inga träffar.");
});
