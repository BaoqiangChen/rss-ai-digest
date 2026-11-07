"use strict";
// Small shared helpers. Loaded by the background page, the options page and the popup.
var RCD = (globalThis.RCD = globalThis.RCD || {});

RCD.api = globalThis.messenger || globalThis.browser;

RCD.util = (() => {
  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeWs(s) {
    return String(s ?? "")
      .replace(/\r/g, "")
      .replace(/[ \t\f\v ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  // Turn an HTML fragment (feed item, newsletter body) into readable plain text.
  function htmlToText(html) {
    if (!html) return "";
    const src = String(html);
    if (!/[<&]/.test(src)) return normalizeWs(src);
    try {
      const doc = new DOMParser().parseFromString(src, "text/html");
      doc.querySelectorAll("script,style,noscript,template,head,svg").forEach((n) => n.remove());
      doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
      doc
        .querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6,tr,blockquote,section,article,pre,table")
        .forEach((el) => el.append("\n"));
      const root = doc.body || doc.documentElement;
      return normalizeWs(root ? root.textContent : "");
    } catch (e) {
      return normalizeWs(src.replace(/<[^>]*>/g, " "));
    }
  }

  function truncate(s, n) {
    s = String(s ?? "");
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > n * 0.8 ? cut.slice(0, lastSpace) : cut) + " …";
  }

  // Normalise a URL so the same article from two feeds (or with tracking params) dedupes.
  function normalizeUrl(u) {
    if (!u) return "";
    try {
      const x = new URL(String(u).trim());
      x.hash = "";
      for (const k of [...x.searchParams.keys()]) {
        if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|cmpid$)/i.test(k)) x.searchParams.delete(k);
      }
      x.hostname = x.hostname.replace(/^www\./, "");
      let out = x.toString();
      if (out.endsWith("/")) out = out.slice(0, -1);
      return out.replace(/^http:/, "https:");
    } catch (e) {
      return String(u).trim();
    }
  }

  function normalizeTitle(t) {
    return String(t ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function itemKey(item) {
    if (item.link) return "u:" + normalizeUrl(item.link);
    return "t:" + normalizeTitle(item.title);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // "a, b\nc" -> ["a","b","c"]
  function parseList(s) {
    if (Array.isArray(s)) return s.map((x) => String(x).trim()).filter(Boolean);
    return String(s ?? "")
      .split(/[\n,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function parseLines(s) {
    return String(s ?? "")
      .split(/\n+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  // Pull every http(s)/feed URL out of free text, whatever the separators (newlines, commas, spaces…).
  function extractUrls(s) {
    const text = Array.isArray(s) ? s.join("\n") : String(s ?? "");
    const found = text.match(/(?:https?|feed):\/\/[^\s,;<>"'(){}\[\]]+/gi) || [];
    const out = [];
    for (let u of found) {
      u = u.replace(/[.)]+$/, "").replace(/^feed:\/\//i, "https://");
      if (!out.includes(u)) out.push(u);
    }
    return out;
  }

  function toDate(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Feed dates. Many journal feeds (e.g. nature.com) give only a day ("2026-11-06").
   * Treat those as the END of that day, so a "last 24 h" window doesn't drop yesterday's papers.
   */
  function parseFeedDate(v) {
    const s = String(v ?? "").trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59);
    return toDate(s);
  }

  // A date exactly at midnight (UTC or local) probably came from a day-only feed date.
  function looksDayOnly(d) {
    d = toDate(d);
    if (!d) return false;
    const utc = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
    const loc = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
    return utc || loc;
  }

  /** Run fn over items with at most `limit` in flight; returns Promise.allSettled-style results. */
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        try {
          results[i] = { status: "fulfilled", value: await fn(items[i], i) };
        } catch (e) {
          results[i] = { status: "rejected", reason: e };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return results;
  }

  function fmtDate(d, withTime = false) {
    d = toDate(d);
    if (!d) return "";
    const opts = withTime
      ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "short", day: "numeric" };
    try {
      return d.toLocaleString(undefined, opts);
    } catch (e) {
      return d.toISOString().slice(0, withTime ? 16 : 10).replace("T", " ");
    }
  }

  function isoDay(d) {
    d = toDate(d) || new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function fillTemplate(tpl, vars) {
    return String(tpl ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Parse JSON that may be wrapped in prose or ``` fences.
  function parseJsonLoose(text) {
    const t = String(text || "").trim();
    try {
      return JSON.parse(t);
    } catch (e) {
      /* fall through */
    }
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch (e) {
        /* fall through */
      }
    }
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch (e) {
        /* fall through */
      }
    }
    throw new Error("The AI did not return valid JSON.");
  }

  function errMsg(e) {
    if (!e) return "Unknown error";
    return e.message || String(e);
  }

  return {
    escapeHtml,
    normalizeWs,
    htmlToText,
    truncate,
    normalizeUrl,
    normalizeTitle,
    itemKey,
    uid,
    parseList,
    parseLines,
    extractUrls,
    toDate,
    parseFeedDate,
    looksDayOnly,
    mapLimit,
    fmtDate,
    isoDay,
    fillTemplate,
    sleep,
    parseJsonLoose,
    errMsg,
  };
})();
