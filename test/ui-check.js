// Renders the settings page and popup in Chromium with a mocked Thunderbird API; reports JS errors.
const { chromium } = require("playwright");
const path = require("path");
const ADDON = path.resolve(__dirname, "..");

const mock = () => {
  const data = {
    settings: { provider: "deepseek", providers: { deepseek: { apiKey: "sk-ds-test", model: "deepseek-flash", effort: "low" }, claude: { apiKey: "sk-ant-test", model: "claude-sonnet-5-5", effort: "medium" } }, defaultIdentityId: "id1" },
    topics: [
      {
        id: "t1", name: "Immunology & cell therapy", color: "#0f766e", enabled: true,
        interests: "Immune engineering; CAR-T, TCR-T and in-vivo CAR approaches; clinical readouts and FDA/EMA decisions.",
        avoid: "Diet tips; press releases with no data.", sections: "Research, Clinical & regulatory, Industry",
        keywords: "", folderIds: ["a1://Nature", "a1://Cell"], feedUrls: ["https://www.science.org/rss/news_current.xml"],
        lookbackHours: 48, onlyNew: true, maxArticles: 80, coverage: "perFeed", perFeedStories: 3, minRelevance: 3, style: "standard", language: "English",
        extraInstructions: "Mention trial phase and patient numbers.",
        email: { identityId: "", to: "", subject: "{topic} digest – {date}", review: false, plainText: false, sendWhenEmpty: false },
        schedule: { type: "daily", time: "07:30", days: [1, 2, 3, 4, 5], hours: 6 },
      },
      {
        id: "t2", name: "AI & machine learning", color: "#7c3aed", enabled: true, interests: "Frontier models", avoid: "", sections: "",
        keywords: "", folderIds: [], feedUrls: [], lookbackHours: 24, onlyNew: true, maxArticles: 80, minRelevance: 3, style: "brief",
        language: "Simplified Chinese (中文)", extraInstructions: "",
        email: { identityId: "", to: "", subject: "{topic} digest – {date}", review: true, plainText: false, sendWhenEmpty: false },
        schedule: { type: "manual", time: "07:30", days: [1, 2, 3, 4, 5], hours: 6 },
      },
    ],
    "state:t1": { lastRun: new Date(Date.now() - 3 * 3600e3).toISOString(), lastStatus: "Sent: 9 stories from 46 articles, 4 feed(s): 3 with new items, 1 failed → chen@example.org (31,204 tokens)", lastError: "", lastFeeds: [{ name: "Immunology : nature.com subject feeds", sent: 18, found: 18 }, { name: "Cancer immunotherapy : nature.com subject feeds", sent: 15, found: 15 }, { name: "Cell Press", sent: 13, found: 13 }, { name: "science.org", sent: 0, found: 0, error: "HTTP 403" }] },
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  window.browser = window.messenger = {
    storage: {
      local: {
        async get(k) {
          const ks = Array.isArray(k) ? k : [k];
          const o = {};
          ks.forEach((x) => x in data && (o[x] = clone(data[x])));
          return o;
        },
        async set(o) { Object.assign(data, clone(o)); },
        async remove(k) { [].concat(k).forEach((x) => delete data[x]); },
      },
    },
    accounts: { async list() { return [{ id: "a1", name: "Science Feeds", type: "rss" }, { id: "a2", name: "chen@example.org", type: "imap" }]; } },
    identities: { async list() { return [{ id: "id1", email: "chen@example.org", name: "Baoqiang Chen", accountId: "a2" }]; } },
    folders: {
      async query({ accountId }) {
        return accountId === "a1"
          ? [{ id: "a1://", isRoot: true, name: "r", path: "/" }, { id: "a1://Nature", name: "Nature – Immunology", path: "/Nature" }, { id: "a1://Cell", name: "Cell Press", path: "/Cell" }, { id: "a1://STAT", name: "STAT News", path: "/STAT" }, { id: "a1://Endpoints", name: "Endpoints News", path: "/Endpoints" }]
          : [{ id: "a2://INBOX", name: "Inbox", path: "/INBOX" }, { id: "a2://INBOX/Newsletters", name: "Newsletters", path: "/INBOX/Newsletters" }];
      },
    },
    messages: { async sendMessage() { return { mode: "sendNow" }; } },
    permissions: {
      _send: false,
      async contains(q) { return q.permissions && q.permissions.includes("messages.send") ? this._send : false; },
      async request(q) { if (q.permissions && q.permissions.includes("messages.send")) this._send = true; return true; },
    },
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage(m) {
        if (m.type === "testKey" && m.provider === "deepseek") return { ok: true, models: [{ id: "deepseek-flash", name: "deepseek-flash" }, { id: "deepseek-v4-pro", name: "deepseek-v4-pro" }] };
        if (m.type === "testKey") return { ok: true, models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }, { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }, { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" }] };
        if (m.type === "nextRuns") return { t1: Date.now() + 18 * 3600e3 };
        if (m.type === "status") return { running: {} };
        return undefined;
      },
      openOptionsPage() {},
      async getBrowserInfo() { return { name: "Thunderbird", version: "153.3.1" }; },
    },
  };
};

require("fs").mkdirSync(path.join(__dirname, "output"), { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const [file, w, h, out, scheme] of [
    ["options/options.html", 1180, 1900, "options.png", "light"],
    ["options/options.html", 1180, 900, "options-dark.png", "dark"],
    ["popup/popup.html", 380, 330, "popup.png", "light"],
  ]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: scheme });
    page.on("pageerror", (e) => errors.push(`${file}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${file} console: ${m.text()}`));
    await page.addInitScript(mock);
    await page.goto("file://" + path.join(ADDON, file));
    await page.waitForTimeout(700);
    if (file.startsWith("options")) {
      // exercise the editor
      const checked = await page.$$eval("#folderTree input:checked", (els) => els.map((e) => e.dataset.folder).sort());
      if (checked.join() !== "a1://Cell,a1://Nature") errors.push("folder selection not restored: " + checked.join());
      if ((await page.inputValue("#apiKey")) !== "sk-ds-test") errors.push("deepseek key not shown");
      const effortOpts = await page.$$eval("#effort option", (o) => o.map((x) => x.value).join());
      if (effortOpts !== "none,low,high,max") errors.push("deepseek effort options: " + effortOpts);
      if (file === "options/options.html" && scheme === "dark") {
        // provider switch round-trip
        await page.selectOption("#provider", "claude");
        await page.waitForTimeout(500);
        if ((await page.inputValue("#apiKey")) !== "sk-ant-test") errors.push("claude key not shown after switch");
        if (!/Opus/.test(await page.textContent("#model"))) errors.push("claude models not loaded");
        const st = await page.evaluate(() => browser.storage.local.get("settings"));
        if (st.settings.provider !== "claude" || st.settings.providers.deepseek.apiKey !== "sk-ds-test") errors.push("provider switch not saved correctly");
        await page.selectOption("#provider", "deepseek");
        await page.waitForTimeout(500);
      }
      if (!/permission/i.test(await page.textContent("#silentStatus")) || !(await page.isVisible("#grantSilent"))) errors.push("silent: allow button not offered");
      await page.click("#grantSilent");
      await page.waitForTimeout(300);
      if (!/Enabled ✓/.test(await page.textContent("#silentStatus")) || (await page.isVisible("#grantSilent"))) errors.push("silent: not enabled after allow: " + (await page.textContent("#silentStatus")));
      const conn = await page.textContent("#connStatus");
      if (!/Connected/.test(conn)) errors.push("connect status: " + conn);
      const status = await page.textContent("#topicStatus");
      if (!/Next scheduled run/.test(status)) errors.push("topic status: " + status);
      await page.selectOption("#t_schedType", "interval");
      const hoursVisible = await page.isVisible("#t_hours");
      const timeVisible = await page.isVisible("#t_time");
      if (!hoursVisible || timeVisible) errors.push("schedule field toggling broken");
      await page.selectOption("#t_schedType", "daily");
      if (!(await page.isVisible("#t_perFeed")) || (await page.isVisible("#t_minRelevance"))) errors.push("coverage fields wrong for perFeed");
      await page.selectOption("#t_coverage", "interests");
      if ((await page.isVisible("#t_perFeed")) || !(await page.isVisible("#t_minRelevance"))) errors.push("coverage fields wrong for interests");
      await page.selectOption("#t_coverage", "perFeed");
      await page.fill("#t_feedUrls", "https://a.org/one.rss, https://b.org/two.rss https://c.org/three.rss");
      await page.click("#save");
      await page.waitForTimeout(1200);
      const saved = await page.evaluate(() => browser.storage.local.get("topics"));
      const t = saved.topics[0];
      if (t.schedule.days.join() !== "1,2,3,4,5" || t.feedUrls.length !== 3 || t.folderIds.length !== 2 || t.coverage !== "perFeed") errors.push("save round-trip wrong: " + JSON.stringify(t));
      if ((await page.inputValue("#t_feedUrls")).split("\n").length !== 3) errors.push("feed URLs not normalised to one per line");
      if (!/Feeds in last run \(4\)[\s\S]*HTTP 403/.test(await page.textContent("#topicStatus"))) errors.push("feed stats missing in status: " + (await page.textContent("#topicStatus")));
      // template creates a topic
      await page.click("#templates button:nth-child(3)");
      await page.waitForTimeout(500);
      const n = await page.evaluate(async () => (await browser.storage.local.get("topics")).topics.length);
      if (n !== 3) errors.push("template did not create topic");
      await page.click("#topicList li:first-child");
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: path.join(__dirname, "output", out), fullPage: true });
    await page.close();
  }
  await browser.close();
  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "UI OK, no JS errors");
})();
