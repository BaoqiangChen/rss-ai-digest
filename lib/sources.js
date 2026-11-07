"use strict";
// Article sources: Thunderbird folders (Feeds accounts, newsletter folders) and feed URLs.
var RCD = (globalThis.RCD = globalThis.RCD || {});

RCD.sources = (() => {
  const U = RCD.util;
  const api = () => RCD.api;

  // ---------- Thunderbird folders ----------

  function flattenFolders(list, out = []) {
    for (const f of list || []) {
      out.push(f);
      if (f.subFolders && f.subFolders.length) flattenFolders(f.subFolders, out);
    }
    return out;
  }

  /** All accounts with their folders, Feeds (RSS) accounts first. */
  async function listFolderTree() {
    const accounts = await api().accounts.list(false);
    const out = [];
    for (const acc of accounts) {
      let folders = [];
      try {
        folders = await api().folders.query({ accountId: acc.id });
      } catch (e) {
        // Older API fallback
        try {
          const full = await api().accounts.get(acc.id, true);
          folders = flattenFolders((full.rootFolder && full.rootFolder.subFolders) || full.folders || []);
        } catch (e2) {
          folders = [];
        }
      }
      folders = folders
        .filter((f) => f && f.id && !f.isRoot && !f.isVirtual && !f.isTag && !f.isUnified)
        .sort((a, b) => String(a.path || "").localeCompare(String(b.path || "")));
      out.push({
        accountId: acc.id,
        accountName: acc.name,
        type: acc.type,
        folders: folders.map((f) => ({
          id: f.id,
          name: f.name,
          path: f.path || "",
          depth: Math.max(0, String(f.path || "").split("/").filter(Boolean).length - 1),
          specialUse: f.specialUse || [],
        })),
      });
    }
    out.sort((a, b) => (b.type === "rss") - (a.type === "rss"));
    return out;
  }

  function firstHeader(part, name) {
    const h = part && part.headers && part.headers[name];
    return Array.isArray(h) ? h[0] : h || "";
  }

  function collectBodies(part, acc = { plain: "", html: "" }) {
    if (!part) return acc;
    const ct = String(part.contentType || "").toLowerCase();
    if (typeof part.body === "string" && part.body) {
      if (ct.startsWith("text/plain") && !acc.plain) acc.plain = part.body;
      else if (ct.startsWith("text/html") && !acc.html) acc.html = part.body;
    }
    for (const p of part.parts || []) collectBodies(p, acc);
    return acc;
  }

  async function itemFromMessage(h, sourceName, maxChars) {
    let link = "";
    let text = "";
    try {
      const full = await api().messages.getFull(h.id);
      link = firstHeader(full, "content-base") || "";
      const { plain, html } = collectBodies(full);
      text = html ? U.htmlToText(html) : U.normalizeWs(plain);
      if (plain && U.normalizeWs(plain).length > text.length) text = U.normalizeWs(plain);
      if (!link && html) {
        const m = html.match(/<base[^>]+href=["']([^"']+)["']/i);
        if (m) link = m[1];
      }
    } catch (e) {
      text = "";
    }
    return {
      origin: "folder",
      source: sourceName || (h.folder && h.folder.name) || "Thunderbird",
      title: h.subject || "(untitled)",
      author: h.author || "",
      date: U.toDate(h.date) ? U.toDate(h.date).toISOString() : "",
      link: String(link || "").trim(),
      text: U.truncate(text, maxChars),
      messageId: h.id,
    };
  }

  // Keep messages inside the window; day-only dates (stored as midnight) count for the whole day.
  function inWindow(date, since) {
    const d = U.toDate(date);
    if (!d || !since) return true;
    if (d >= since) return true;
    return U.looksDayOnly(d) && d.getTime() + 24 * 3600e3 > since.getTime();
  }

  async function collectFromFolders(folderIds, since, { maxPerFolder = 200, maxChars = 1500, onProgress } = {}) {
    const items = [];
    const errors = [];
    const stats = [];
    // Query one extra day back so day-only feed dates aren't lost; filter precisely below.
    const queryFrom = since ? new Date(since.getTime() - 24 * 3600e3) : undefined;
    for (const folderId of folderIds || []) {
      let folderName = "";
      try {
        const f = await api().folders.get(folderId, false);
        folderName = (f && f.name) || "";
      } catch (e) {
        /* ignore */
      }
      const stat = { kind: "folder", id: folderId, name: folderName || folderId, found: 0, error: "" };
      stats.push(stat);
      const headers = [];
      try {
        let page = await api().messages.query({ folderId, fromDate: queryFrom });
        while (page) {
          headers.push(...(page.messages || []).filter((h) => inWindow(h.date, since)));
          if (!page.id || headers.length >= maxPerFolder) break;
          page = await api().messages.continueList(page.id);
        }
        if (page && page.id) {
          try {
            await api().messages.abortList(page.id);
          } catch (e) {
            /* ignore */
          }
        }
      } catch (e) {
        stat.error = U.errMsg(e);
        errors.push(`${stat.name}: ${stat.error}`);
        continue;
      }
      headers.sort((a, b) => new Date(b.date) - new Date(a.date));
      const picked = headers.slice(0, maxPerFolder);
      stat.found = picked.length;
      if (onProgress) onProgress(`Reading ${picked.length} messages from “${stat.name}”…`);
      for (const h of picked) {
        const it = await itemFromMessage(h, folderName, maxChars);
        it.sourceId = folderId;
        items.push(it);
      }
    }
    return { items, errors, stats };
  }

  // ---------- Feed URLs (RSS 2.0, RSS 1.0/RDF, Atom) ----------

  function kids(el, name) {
    if (!el) return [];
    return Array.from(el.children).filter((c) => c.localName === name || String(c.nodeName || "").split(":").pop() === name);
  }
  function kid(el, name) {
    return kids(el, name)[0] || null;
  }
  function txt(el) {
    return el ? String(el.textContent || "").trim() : "";
  }
  function resolve(href, base) {
    if (!href) return "";
    try {
      return new URL(href, base).toString();
    } catch (e) {
      return href;
    }
  }

  function parseFeed(xml, baseUrl = "") {
    const doc = new DOMParser().parseFromString(String(xml || "").replace(/^﻿/, "").trim(), "application/xml");
    if (!doc || !doc.documentElement || doc.getElementsByTagName("parsererror").length) {
      throw new Error("Not a valid RSS/Atom feed");
    }
    const root = doc.documentElement;
    const rootName = String(root.localName || "").toLowerCase();
    const items = [];
    let title = "";

    if (rootName === "feed") {
      // Atom
      title = txt(kid(root, "title"));
      for (const e of kids(root, "entry")) {
        const links = kids(e, "link");
        const alt =
          links.find((l) => (l.getAttribute("rel") || "alternate") === "alternate" && /html|^$/.test(l.getAttribute("type") || "")) ||
          links.find((l) => (l.getAttribute("rel") || "alternate") === "alternate") ||
          links[0];
        const content = kid(e, "content") || kid(e, "summary");
        items.push({
          title: txt(kid(e, "title")),
          link: resolve(alt && alt.getAttribute("href"), baseUrl),
          date: txt(kid(e, "published")) || txt(kid(e, "updated")),
          html: content ? content.textContent : "",
          author: txt(kid(kid(e, "author"), "name")),
        });
      }
    } else if (rootName === "rss" || rootName === "rdf") {
      const channel = kid(root, "channel");
      title = txt(kid(channel || root, "title"));
      const itemEls = kids(channel, "item").concat(kids(root, "item"));
      for (const it of itemEls) {
        const guid = kid(it, "guid");
        const guidLink = guid && guid.getAttribute("isPermaLink") !== "false" && /^https?:/i.test(txt(guid)) ? txt(guid) : "";
        const encoded = kids(it, "encoded")[0];
        items.push({
          title: txt(kid(it, "title")),
          link: resolve(txt(kid(it, "link")) || guidLink || (it.getAttribute("rdf:about") || ""), baseUrl),
          date: txt(kid(it, "pubDate")) || txt(kid(it, "date")) || txt(kid(it, "published")) || txt(kid(it, "updated")),
          html: encoded ? encoded.textContent : txt(kid(it, "description")),
          author: txt(kid(it, "creator")) || txt(kid(it, "author")),
        });
      }
    } else {
      throw new Error("Unknown feed format <" + root.localName + ">");
    }
    return { title, items };
  }

  async function fetchFeedOnce(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        credentials: "omit",
        cache: "no-cache",
        headers: { Accept: "application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5" },
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return parseFeed(await res.text(), res.url || url);
    } catch (e) {
      if (e && e.name === "AbortError") {
        const err = new Error("timed out");
        err.status = 408;
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Retries busy/rate-limited responses (sites like nature.com throttle many parallel requests).
  async function fetchFeed(url, { timeoutMs = 30000, tries = 3 } = {}) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        return await fetchFeedOnce(url, timeoutMs);
      } catch (e) {
        last = e;
        if (![408, 425, 429, 500, 502, 503, 504].includes(e.status) || i === tries - 1) throw e;
        await U.sleep(2000 * (i + 1) + Math.random() * 1000);
      }
    }
    throw last;
  }

  async function collectFromUrls(urls, since, { maxChars = 1500, onProgress, concurrency = 3 } = {}) {
    const items = [];
    const errors = [];
    const stats = [];
    const list = U.extractUrls(urls);
    if (!list.length) return { items, errors, stats };
    let done = 0;
    if (onProgress) onProgress(`Downloading ${list.length} feed(s)…`);
    const results = await U.mapLimit(list, concurrency, async (u) => {
      const r = await fetchFeed(u);
      done++;
      if (onProgress) onProgress(`Downloaded ${done}/${list.length} feeds…`);
      return r;
    });
    results.forEach((r, i) => {
      const url = list[i];
      let host = url;
      try {
        host = new URL(url).hostname.replace(/^www\./, "");
      } catch (e) {
        /* ignore */
      }
      const stat = { kind: "url", id: url, name: host, total: 0, found: 0, error: "" };
      stats.push(stat);
      if (r.status === "rejected") {
        const m = U.errMsg(r.reason);
        stat.error = m + (/NetworkError|Failed to fetch|CORS/i.test(m) ? " (allow website access on the settings page)" : "");
        errors.push(`${url}: ${stat.error}`);
        return;
      }
      stat.name = r.value.title || host;
      stat.total = r.value.items.length;
      for (const it of r.value.items) {
        const d = U.parseFeedDate(it.date);
        if (d && since && d < since) continue;
        stat.found++;
        items.push({
          origin: "url",
          sourceId: url,
          source: stat.name,
          title: U.htmlToText(it.title) || "(untitled)",
          author: it.author || "",
          date: d ? d.toISOString() : "",
          link: it.link || "",
          text: U.truncate(U.htmlToText(it.html), maxChars),
        });
      }
    });
    return { items, errors, stats };
  }

  async function collect(topic, settings, since, onProgress) {
    const maxChars = settings.maxCharsPerArticle || 1500;
    const a = await collectFromFolders(topic.folderIds, since, { maxChars, onProgress });
    const b = await collectFromUrls(topic.feedUrls, since, { maxChars, onProgress });
    return { items: a.items.concat(b.items), errors: a.errors.concat(b.errors), stats: a.stats.concat(b.stats) };
  }

  return { listFolderTree, collect, collectFromFolders, collectFromUrls, parseFeed, fetchFeed, collectBodies };
})();
