// Ingång för Cloudflare: schemat (varje minut) ser till att bevakningens timer går,
// /status, /test, /pause, /resume (med ?token=APP_TOKEN) går till bevakningen och
// /data/... till databasen (D1).
import { handleData } from "./data.js";

export { Watcher } from "./watcher.js";

const watcher = (env) => env.WATCHER.get(env.WATCHER.idFromName("main"));

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(watcher(env).fetch("https://watcher/ensure"));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? request.headers.get("x-app-token");
    if (!env.APP_TOKEN || token !== env.APP_TOKEN) return new Response("Fel token", { status: 401 });
    if (url.pathname.startsWith("/data/")) return handleData(request, env, url.pathname);
    return watcher(env).fetch(`https://watcher${url.pathname}${url.search}`);
  },
};
