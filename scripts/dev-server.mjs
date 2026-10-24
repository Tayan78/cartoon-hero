// Lokal utvecklingsserver: serverar public/ och kör api/*.js som Vercel gör.
//   npm run dev        – riktiga anrop (kräver .env.local)
//   npm run dev:mock   – fejkade svar, ingen API-nyckel behövs
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const envFile = join(root, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (process.env.MOCK === "1") process.env.APP_TOKEN ??= "test";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/[^a-z-]/g, "");
      const file = join(root, "api", `${name}.js`);
      if (!existsSync(file)) return void res.writeHead(404).end();
      const mod = await import(file);
      const handler = mod[req.method];
      if (!handler) return void res.writeHead(405).end();
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    const data = await readFile(join(root, "public", path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT") return void res.writeHead(404).end("Hittades inte");
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(err.message));
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Loppisskannern körs på http://localhost:${port}${process.env.MOCK === "1" ? " (testläge, lösenord: test)" : ""}`);
});
