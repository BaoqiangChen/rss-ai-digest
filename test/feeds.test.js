const test = require("node:test");
const assert = require("node:assert/strict");
const { makeMessenger, load, LIB } = require("./harness");

function mockFetch(env, handler) {
  globalThis.fetch = async (url, init = {}) => {
    env.calls.fetch.push({ url: String(url), init });
    const r = await handler(String(url), init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: "",
      url: String(url),
      headers: { get: (h) => (r.headers || {})[h.toLowerCase()] || null },
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
}

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

// nature.com subject feeds are RSS 1.0 with day-only dc:date and title-only content.
function natureFeed(subject, n, date) {
  const items = Array.from({ length: n }, (_, i) => `
  <item rdf:about="https://www.nature.com/articles/${subject}-${i}">
    <title><![CDATA[${subject} paper ${i}]]></title>
    <link>https://www.nature.com/articles/${subject}-${i}</link>
    <content:encoded><![CDATA[<p>Scientific Reports, Published online: ${date}; <a href="https://doi.org/x">doi:x</a></p>${subject} paper ${i}]]></content:encoded>
    <dc:title><![CDATA[${subject} paper ${i}]]></dc:title>
    <dc:date>${date}</dc:date>
  </item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns="http://purl.org/rss/1.0/">
<channel rdf:about="https://www.nature.com/subjects/${subject}.rss"><title>${subject} : nature.com subject feeds</title></channel>${items}
</rdf:RDF>`;
}

test("extractUrls accepts any separators and dedupes", () => {
  const R = load(LIB, makeMessenger());
  const urls = R.util.extractUrls(
    "https://www.nature.com/subjects/immunology.rss, https://www.nature.com/subjects/cancer.rss https://a.org/feed.xml;\n" +
      "feed://b.org/rss\nhttps://www.nature.com/subjects/immunology.rss\n(https://c.org/atom.xml)."
  );
  assert.deepEqual(urls, [
    "https://www.nature.com/subjects/immunology.rss",
    "https://www.nature.com/subjects/cancer.rss",
    "https://a.org/feed.xml",
    "https://b.org/rss",
    "https://c.org/atom.xml",
  ]);
});

test("day-only feed dates count for the whole day", () => {
  const R = load(LIB, makeMessenger());
  const d = R.util.parseFeedDate(day(-1));
  assert.equal(d.getHours(), 23);
  const since = new Date(Date.now() - 24 * 3600e3);
  assert.ok(d >= since, "yesterday's day-only item is inside a 24 h window");
  assert.equal(R.util.parseFeedDate("2026-11-06T10:00:00Z").toISOString(), "2026-11-06T10:00:00.000Z");
});

test("fair share: a busy feed can't crowd out small feeds", () => {
  const R = load(LIB, makeMessenger());
  const raw = [];
  for (let i = 0; i < 50; i++) raw.push({ sourceId: "A", source: "Big", title: "big story number " + i, link: "https://a/" + i, text: "", date: new Date(Date.now() - i * 1000).toISOString() });
  for (let i = 0; i < 3; i++) raw.push({ sourceId: "B", source: "Small", title: "small story number " + i, link: "https://b/" + i, text: "", date: new Date(Date.now() - 1e7).toISOString() });
  for (let i = 0; i < 2; i++) raw.push({ sourceId: "C", source: "Tiny", title: "tiny story number " + i, link: "https://c/" + i, text: "", date: new Date(Date.now() - 2e7).toISOString() });
  const topic = R.store.newTopic({ maxArticles: 12 });
  const items = R.digest.prepareItems(raw, topic, new Set());
  const count = (s) => items.filter((i) => i.sourceId === s).length;
  assert.equal(items.length, 12);
  assert.equal(count("B"), 3);
  assert.equal(count("C"), 2);
  assert.equal(count("A"), 7);
  assert.deepEqual(items.map((i) => i.id), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(items[0].title, "big story number 0", "grouped by feed, newest first");
});

test("feed fetching retries 429 and limits concurrency", async () => {
  const env = makeMessenger();
  const R = load(LIB, env);
  R.util.sleep = async () => {};
  let inFlight = 0;
  let maxInFlight = 0;
  const hits = {};
  mockFetch(env, async (url) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    hits[url] = (hits[url] || 0) + 1;
    if (url.endsWith("immunology.rss") && hits[url] === 1) return { status: 429, body: "slow down" };
    if (url.endsWith("missing.rss")) return { status: 404, body: "nf" };
    const subject = url.split("/").pop().replace(".rss", "");
    return { status: 200, body: natureFeed(subject, 4, day(-1)) };
  });
  const urls = ["immunology", "cancer", "genetics", "neuroscience", "missing"].map((s) => `https://www.nature.com/subjects/${s}.rss`);
  const since = new Date(Date.now() - 24 * 3600e3);
  const r = await R.sources.collectFromUrls(urls.join(", "), since, {});
  assert.ok(maxInFlight <= 3, "at most 3 parallel requests, saw " + maxInFlight);
  assert.equal(hits[urls[0]], 2, "429 retried");
  assert.equal(r.items.length, 16, "4 feeds x 4 day-only items from yesterday");
  assert.equal(r.stats.length, 5);
  assert.equal(r.stats[0].name, "immunology : nature.com subject feeds");
  assert.equal(r.stats[0].found, 4);
  assert.match(r.stats[4].error, /HTTP 404/);
  assert.equal(r.items[0].sourceId, urls[0]);
});

test("folder messages with day-only (midnight) dates are kept", async () => {
  const y = new Date();
  y.setUTCDate(y.getUTCDate() - 1);
  y.setUTCHours(0, 0, 0, 0); // how Thunderbird stores a day-only feed date
  const env = makeMessenger({
    feedMessages: [{ id: 1, folderId: "account1://Nature", subject: "Midnight paper", author: "", date: y.toISOString(), link: "https://n/m", html: "<p>m</p>" }],
  });
  const R = load(LIB, env);
  const since = new Date(Date.now() - 24 * 3600e3);
  const r = await R.sources.collectFromFolders(["account1://Nature"], since, {});
  assert.equal(r.items.length, 1);
  assert.equal(r.stats[0].found, 1);
});

test("per-feed mode: prompt lists sources; every feed appears in the email", async () => {
  const env = makeMessenger();
  const R = load(LIB.concat(["background.js"]), env);
  R.util.sleep = async () => {};
  let prompt;
  mockFetch(env, async (url, init) => {
    if (url.startsWith("https://api.deepseek.com")) {
      prompt = JSON.parse(init.body);
      const user = prompt.messages[1].content;
      const idOf = (title) => +user.match(new RegExp(`<article id="(\\d+)">\\nsource: [^\\n]*\\ntitle: ${title}\\n`))[1];
      // The model only covers the first feed (and overshoots the per-feed limit).
      return {
        status: 200,
        body: {
          model: "deepseek-flash",
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
            takeaways: ["x"],
            sections: [{ title: "Immunology", entries: [0, 1, 2, 3].map((i) => ({ id: idOf(`immunology paper ${i}`), related_ids: [], relevance: 1, headline: `Immuno ${i}`, summary: "s", why_it_matters: "w" })) }],
            note: "",
          }) } }],
          usage: {},
        },
      };
    }
    if (url.endsWith("missing.rss")) return { status: 404, body: "nf" };
    const subject = url.split("/").pop().replace(".rss", "");
    return { status: 200, body: natureFeed(subject, 5, day(0)) };
  });
  await R.store.saveProvider("deepseek", { apiKey: "k" });
  const t = R.store.newTopic({
    name: "Science",
    coverage: "perFeed",
    perFeedStories: 2,
    lookbackHours: 24,
    feedUrls: ["immunology", "physics", "ecology", "missing"].map((s) => `https://www.nature.com/subjects/${s}.rss`),
  });
  await R.store.upsertTopic(t);
  const res = await R.bg.runTopic(t.id);
  assert.equal(res.ok, true);

  const user = prompt.messages[1].content;
  assert.match(user, /<sources>\n1\. immunology : nature.com subject feeds \(5 articles\)\n2\. physics/);
  assert.match(prompt.messages[0].content, /ONE section per source/);
  assert.doesNotMatch(prompt.messages[0].content, /Keep only stories with relevance/);

  const body = env.calls.beginNew[0].body;
  // model's section capped at 2 even though it returned 4 low-relevance entries
  assert.match(body, /Immuno 0/);
  assert.match(body, /Immuno 1/);
  assert.doesNotMatch(body, /Immuno 2/);
  // feeds the model skipped are still listed by title
  assert.match(body, /physics : nature.com subject feeds/);
  assert.match(body, /physics paper 0/);
  assert.match(body, /ecology paper 0/);
  assert.match(body, /Not summarised \(listed by title\)/);
  // footer lists every feed, including the failed one
  assert.match(body, /Feeds read \(4\)/);
  assert.match(body, /ecology : nature.com subject feeds — 5 read/);
  assert.match(body, /nature.com — ⚠ failed: HTTP 404/);
  const st = await R.store.getState(t.id);
  assert.match(st.lastStatus, /4 feed\(s\): 3 with new items, 1 failed/);
  assert.equal(st.lastFeeds.length, 4);
});
