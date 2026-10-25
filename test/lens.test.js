
test("utan krediter i SerpApi ger Lens ett tydligt fel (bildsöket tar då över i appen)", async () => {
  process.env.SERPAPI_API_KEY = "nyckel";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Your account has run out of searches." }), { status: 429 });
  try {
    await assert.rejects(lensSearch({ mediaType: "image/jpeg", data: "AAAA" }, fx), /run out of searches/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
