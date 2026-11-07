// Loads the add-on's scripts into Node with a mocked Thunderbird `messenger` API.
const path = require("path");
const { JSDOM } = require("jsdom");
const { DOMParser } = new JSDOM("").window;
const ADDON = path.resolve(__dirname, "..");

function makeMessenger(opts = {}) {
  const calls = { beginNew: [], sendMessage: [], notifications: [], alarms: [], fetch: [], silentSend: [], windowsUpdate: [], permRequests: [] };
  const storageData = {};
  const listeners = { onMessage: [], onAlarm: [], onChanged: [] };
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  const feedMessages = opts.feedMessages || [];
  const m = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return clone(storageData);
          const ks = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
          const out = {};
          for (const k of ks) if (k in storageData) out[k] = clone(storageData[k]);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: storageData[k], newValue: v };
            storageData[k] = clone(v);
          }
          listeners.onChanged.forEach((f) => f(changes, "local"));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) delete storageData[k];
        },
      },
      onChanged: { addListener: (f) => listeners.onChanged.push(f) },
    },
    accounts: {
      async list() {
        return [
          { id: "account1", name: "Blogs & News Feeds", type: "rss", identities: [] },
          {
            id: "account2",
            name: "Work mail",
            type: "imap",
            identities: [{ id: "id1", email: "chen@example.org", name: "Baoqiang Chen", label: "", accountId: "account2" }],
          },
        ];
      },
    },
    identities: {
      async list() {
        return [{ id: "id1", email: "chen@example.org", name: "Baoqiang Chen", label: "", accountId: "account2" }];
      },
    },
    folders: {
      async query({ accountId }) {
        if (accountId === "account1")
          return [
            { id: "account1://", name: "Root", path: "/", isRoot: true },
            { id: "account1://Nature", name: "Nature", path: "/Nature" },
            { id: "account1://Trash", name: "Trash", path: "/Trash", specialUse: ["trash"] },
          ];
        return [
          { id: "account2://", name: "Root", path: "/", isRoot: true },
          { id: "account2://INBOX", name: "Inbox", path: "/INBOX", specialUse: ["inbox"] },
          { id: "account2://INBOX/News", name: "Newsletters", path: "/INBOX/Newsletters" },
        ];
      },
      async get(id) {
        return { id, name: id.split("/").pop() || id };
      },
    },
    messages: {
      async query({ folderId, fromDate }) {
        const msgs = feedMessages.filter((x) => x.folderId === folderId && new Date(x.date) >= fromDate);
        return { id: null, messages: msgs.map((x) => ({ id: x.id, subject: x.subject, author: x.author, date: new Date(x.date), folder: { name: "Nature" } })) };
      },
      async continueList() {
        return { id: null, messages: [] };
      },
      async abortList() {},
      async getFull(id) {
        const x = feedMessages.find((y) => y.id === id);
        return {
          contentType: "multipart/alternative",
          headers: { "content-base": [x.link] },
          parts: [{ contentType: "text/html", body: x.html }],
        };
      },
    },
    compose: {
      async beginNew(details) {
        calls.beginNew.push(details);
        return { id: 42, windowId: 7 };
      },
      async sendMessage(tabId, o) {
        calls.sendMessage.push({ tabId, o });
        if (opts.sendFails) throw new Error("SMTP failed");
        return { mode: "sendNow", messages: [] };
      },
    },
    alarms: {
      _a: {},
      async clear(n) {
        delete m.alarms._a[n];
      },
      create(n, o) {
        calls.alarms.push({ n, o });
        m.alarms._a[n] = { name: n, scheduledTime: o.when };
      },
      async getAll() {
        return Object.values(m.alarms._a);
      },
      onAlarm: { addListener: (f) => listeners.onAlarm.push(f) },
    },
    runtime: {
      sendMessage: async () => {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      },
      onMessage: { addListener: (f) => listeners.onMessage.push(f) },
      getURL: (p) => "moz-extension://test/" + p,
      getBrowserInfo: async () => ({ name: "Thunderbird", vendor: "Mozilla", version: opts.tbVersion || "153.3.1", buildID: "x" }),
      openOptionsPage() {},
    },
    notifications: {
      async create(o) {
        calls.notifications.push(o);
      },
    },
    permissions: {
      async contains(p) {
        if (p && p.permissions && p.permissions.includes("messages.send")) {
          if (opts.tbVersion && parseInt(opts.tbVersion, 10) < 153) throw new Error("Type error for parameter permissions");
          return !!opts.sendPermission;
        }
        return true;
      },
      async request(p) {
        calls.permRequests.push(p);
        if (p && p.permissions && p.permissions.includes("messages.send")) opts.sendPermission = true;
        return true;
      },
    },
    windows: {
      async update(id, o) {
        calls.windowsUpdate.push({ id, o });
      },
    },
    browserAction: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  if (opts.silentApi) {
    m.messages.sendMessage = async (details, o) => {
      calls.silentSend.push({ details, o });
      if (opts.sendFails) throw new Error("SMTP failed");
      return { mode: "sendNow", headerMessageId: "x@y", messages: [] };
    };
  }
  return { messenger: m, calls, storageData, listeners };
}

function load(files, env) {
  globalThis.DOMParser = DOMParser;
  globalThis.messenger = env.messenger;
  globalThis.RCD = undefined;
  delete globalThis.RCD;
  for (const f of files) {
    const p = path.join(ADDON, f);
    delete require.cache[require.resolve(p)];
    require(p);
  }
  return globalThis.RCD;
}

const LIB = ["lib/util.js", "lib/store.js", "lib/claude.js", "lib/deepseek.js", "lib/ai.js", "lib/sources.js", "lib/digest.js", "lib/mailer.js", "lib/schedule.js"];

module.exports = { makeMessenger, load, LIB, ADDON };
