// Bevakningen: en Durable Object som var 10:e sekund söker de nyaste annonserna i
// kategorin Miniatyrer & leksaksfigurer och plingar via Telegram (ntfy som reserv) när ett Köp nu-parti
// är värt minst 1,5× priset. Traderas gräns är 10 000 anrop per dygn och metod:
// 1 sökning var 10:e sekund = 8 640 per dygn.
import { DurableObject } from "cloudflare:workers";
import { searchAdvanced, traderaGet } from "../../lib/tradera.js";
import { EXAMPLE_DEAL, WATCH_NICHES, candidates, chatFromUpdates, evaluate, notification, pageOrder, pickOrderBy, searchBody, telegramMessage } from "./watch.js";

const INTERVAL_MS = 10_000;
const SEEN_MAX = 5000; // senast sedda annonser (räcker gott för 50 per sökning)
const SINGLES_MAX_AGE = 60 * 60 * 1000; // marknadspriserna hämtas om varje timme

export class Watcher extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/ensure") {
      await this.ensure();
      return new Response("ok");
    }
    if (path === "/status") return Response.json(await this.status());
    if (path === "/test") {
      const via = url.searchParams.has("annons")
        ? await this.notify(notification(EXAMPLE_DEAL, this.env.NTFY_TOPIC))
        : await this.notify({ title: "✅ Test från Loppisskannern", message: "Bevakningen kan skicka notiser till dig.", priority: 4 });
      if (via) return new Response(`Testnotis skickad via ${via}`);
      const [tg, nt] = await Promise.all([this.ctx.storage.get("telegram_error"), this.ctx.storage.get("notify_error")]);
      return new Response(`Kunde inte skicka: ${[tg && `Telegram: ${tg}`, nt].filter(Boolean).join(" · ")}`);
    }
    if (path === "/telegram") return new Response(await this.linkTelegram());
    if (path === "/pause" || path === "/resume") {
      await this.ctx.storage.put("paused", path === "/pause");
      if (path === "/resume") await this.ensure();
      return new Response(path === "/pause" ? "Pausad" : "Igång");
    }
    return new Response("Loppisskannerns bevakning. /status, /test, /test?annons=1, /telegram, /pause, /resume");
  }

  // Startar timern om den inte går (anropas varje minut av Cloudflares schema).
  async ensure() {
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm < Date.now() - 60_000) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async alarm() {
    const s = this.ctx.storage;
    try {
      if (!(await s.get("paused"))) await this.poll();
    } catch (err) {
      await s.put("last_error", { at: new Date().toISOString(), message: String(err?.message ?? err) });
    } finally {
      await s.setAlarm(Date.now() + INTERVAL_MS);
    }
  }

  async poll() {
    const s = this.ctx.storage;
    let orderBy = await s.get("order_by");
    // Version 2 av valet kontrollerar även att sidan verkligen är sorterad.
    if (orderBy === undefined || (await s.get("order_check")) !== 2) {
      orderBy = await pickOrderBy(searchAdvanced);
      await s.put({ order_by: orderBy, order_check: 2 });
    }
    const data = await searchAdvanced(searchBody(orderBy));
    const items = data?.items ?? data?.Items ?? [];
    const seenList = (await s.get("seen")) ?? [];
    const seen = new Set(seenList);
    const stats = (await s.get("stats")) ?? { polls: 0, items: 0, candidates: 0, deals: 0 };
    stats.polls++;
    stats.last_poll = new Date().toISOString();
    // Syns i /status: högsta annons-id (ska öka när nya läggs ut) och om sidan är sorterad.
    stats.page = pageOrder(items);

    // Första körningen: allt som redan ligger ute räknas som sett (ingen notisflod).
    if (!(await s.get("initialized"))) {
      for (const it of items) seen.add(String(it.id ?? it.Id));
      await s.put({ initialized: true, seen: [...seen].slice(-SEEN_MAX), stats });
      return;
    }

    const cands = candidates(items, seen, WATCH_NICHES);
    for (const it of items) {
      const id = String(it.id ?? it.Id);
      if (!seen.has(id)) {
        seen.add(id);
        stats.items++;
      }
    }
    stats.candidates += cands.length;

    if (cands.length) {
      const { singles, rules } = await this.singles();
      const deals = await evaluate(cands, { getItem: traderaGet, singles, rules });
      for (const deal of deals) {
        await this.notify(notification(deal, this.env.NTFY_TOPIC));
        stats.deals++;
        stats.last_deal = { at: new Date().toISOString(), title: deal.title, url: deal.url, total: deal.total, value: deal.value };
      }
    }
    await s.put({ seen: [...seen].slice(-SEEN_MAX), stats, last_error: null });
  }

  // Styckförsäljningen per nisch från appen (fliken Marknad), cachad en timme.
  async singles() {
    const s = this.ctx.storage;
    const cached = await s.get("singles");
    if (cached && Date.now() - cached.at < SINGLES_MAX_AGE) return cached;
    const res = await fetch(`${this.env.APP_URL}/api/marketdata`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": this.env.APP_TOKEN },
      body: JSON.stringify({ action: "singles", niches: WATCH_NICHES }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      if (cached) return cached; // hellre gamla priser än inga
      throw new Error(`Kunde inte hämta marknadspriser: ${data.error || res.status}`);
    }
    const fresh = { at: Date.now(), singles: data.singles, rules: data.rules };
    await s.put("singles", fresh);
    return fresh;
  }

  // Telegram i första hand, ntfy som reserv. Felen sparas så att /test och /status visar varför.
  // Returnerar vägen notisen gick ("Telegram"/"ntfy"), eller null.
  async notify(message) {
    if (await this.telegram(message)) return "Telegram";
    return (await this.ntfy(message)) ? "ntfy" : null;
  }

  async telegramChat() {
    return this.env.TELEGRAM_CHAT_ID || (await this.ctx.storage.get("telegram_chat"))?.id;
  }

  async telegramCall(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${res.status}: ${data.description ?? "okänt fel"}`);
    return data.result;
  }

  async telegram(message) {
    const s = this.ctx.storage;
    const chat = this.env.TELEGRAM_BOT_TOKEN && (await this.telegramChat());
    if (!chat) return false;
    const { method, body } = telegramMessage(message, chat);
    try {
      try {
        await this.telegramCall(method, body);
      } catch (err) {
        if (method !== "sendPhoto") throw err;
        // Telegram kunde inte hämta bilden – skicka utan.
        const { attach, ...rest } = message;
        const plain = telegramMessage(rest, chat);
        await this.telegramCall(plain.method, plain.body);
      }
      await s.delete("telegram_error");
      return true;
    } catch (err) {
      await s.put("telegram_error", err.message);
      return false;
    }
  }

  // Kopplar telefonen: skriv något till boten i Telegram och öppna sedan /telegram.
  async linkTelegram() {
    if (!this.env.TELEGRAM_BOT_TOKEN) return "TELEGRAM_BOT_TOKEN saknas – lägg in den i GitHub och deploya igen.";
    try {
      const chat = chatFromUpdates(await this.telegramCall("getUpdates", { allowed_updates: ["message"] }));
      if (!chat) return "Hittade inget meddelande till boten. Öppna boten i Telegram, tryck Starta (eller skriv något) och ladda om sidan.";
      await this.ctx.storage.put("telegram_chat", chat);
      await this.telegramCall("sendMessage", { chat_id: chat.id, text: "✅ Kopplad! Här kommer notiserna från Loppisskannerns bevakning." });
      return `Kopplad till ${chat.name}. Kolla Telegram – en bekräftelse är skickad.`;
    } catch (err) {
      return `Kunde inte koppla: ${err.message}`;
    }
  }

  async ntfy(message) {
    const s = this.ctx.storage;
    if (!this.env.NTFY_TOPIC) {
      await s.put("notify_error", "NTFY_TOPIC saknas");
      return false;
    }
    try {
      const res = await fetch("https://ntfy.sh/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.env.NTFY_TOKEN ? { Authorization: `Bearer ${this.env.NTFY_TOKEN}` } : {}),
        },
        body: JSON.stringify({ topic: this.env.NTFY_TOPIC, ...message }),
      });
      if (res.ok) {
        await s.delete("notify_error");
        return true;
      }
      await s.put("notify_error", `ntfy ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } catch (err) {
      await s.put("notify_error", `ntfy: ${err.message}`);
    }
    return false;
  }

  async status() {
    const s = this.ctx.storage;
    const [stats, lastError, orderBy, singles, paused, alarm, notifyError, tgChat, tgError] = await Promise.all([
      s.get("stats"), s.get("last_error"), s.get("order_by"), s.get("singles"), s.get("paused"), s.getAlarm(), s.get("notify_error"),
      s.get("telegram_chat"), s.get("telegram_error"),
    ]);
    return {
      running: Boolean(alarm) && !paused,
      paused: Boolean(paused),
      next_poll: alarm ? new Date(alarm).toISOString() : null,
      niches: WATCH_NICHES,
      order_by: orderBy ?? "(inte vald än)",
      stats: stats ?? null,
      market_prices: singles ? { fetched: new Date(singles.at).toISOString(), niches: Object.fromEntries(Object.entries(singles.singles ?? {}).map(([k, v]) => [k, v?.all?.n ?? 0])) } : null,
      last_error: lastError ?? null,
      telegram: {
        bot: Boolean(this.env.TELEGRAM_BOT_TOKEN),
        linked: this.env.TELEGRAM_CHAT_ID ? "TELEGRAM_CHAT_ID" : tgChat?.name ?? null,
        error: tgError ?? null,
      },
      ntfy: Boolean(this.env.NTFY_TOPIC),
      ntfy_error: notifyError ?? null,
    };
  }
}
