"use strict";
// Persistent settings, topics ("custom summary themes"), run state, seen-article cache and history.
var RCD = (globalThis.RCD = globalThis.RCD || {});

RCD.store = (() => {
  const local = () => RCD.api.storage.local;

  // AI providers the add-on can use. DeepSeek is the default.
  const PROVIDERS = {
    deepseek: {
      label: "DeepSeek",
      model: "deepseek-flash",
      effort: "low",
      keyUrl: "https://platform.deepseek.com/api_keys",
      keyPlaceholder: "sk-…",
      efforts: [
        ["none", "Off – fastest, cheapest"],
        ["low", "Low"],
        ["high", "High"],
        ["max", "Max"],
      ],
      hint:
        "Create a key at platform.deepseek.com → API keys. DeepSeek is prepaid: top up your balance there. The key is stored only in your Thunderbird profile.",
    },
    claude: {
      label: "Claude",
      model: "claude-sonnet-5-5",
      effort: "medium",
      keyUrl: "https://platform.claude.com/settings/keys",
      keyPlaceholder: "sk-ant-…",
      efforts: [
        ["", "Model default"],
        ["low", "Low"],
        ["medium", "Medium"],
        ["high", "High"],
      ],
      hint:
        "Create a key at platform.claude.com → API keys (billed to that Console account; Claude Pro/Max chat subscriptions can't be used by add-ons). The key is stored only in your Thunderbird profile.",
    },
  };

  const DEFAULT_SETTINGS = {
    provider: "deepseek",
    providers: {
      deepseek: { apiKey: "", model: PROVIDERS.deepseek.model, effort: PROVIDERS.deepseek.effort },
      claude: { apiKey: "", model: PROVIDERS.claude.model, effort: PROVIDERS.claude.effort },
    },
    maxTokens: 16000,
    maxCharsPerArticle: 1500,
    defaultIdentityId: "",
    silentSend: true, // send in the background without a compose window (Thunderbird 153+)
    notify: true,
  };

  const DEFAULT_EMAIL = {
    identityId: "", // "" = use the default sender from Settings
    to: "", // "" = send to yourself
    subject: "{topic} digest – {date}",
    review: false, // true = open the compose window instead of sending
    plainText: false,
    sendWhenEmpty: false,
  };

  const DEFAULT_SCHEDULE = {
    type: "manual", // manual | daily | interval
    time: "07:30",
    days: [1, 2, 3, 4, 5],
    hours: 6,
  };

  function newTopic(overrides = {}) {
    const t = {
      id: RCD.util.uid(),
      name: "New topic",
      enabled: true,
      color: "#0b6bcb",
      interests: "",
      avoid: "",
      sections: "",
      keywords: "",
      folderIds: [],
      feedUrls: [],
      lookbackHours: 48, // safe to be generous: "skip already sent" prevents repeats
      onlyNew: true,
      maxArticles: 80,
      coverage: "interests", // "interests" = only matching stories; "perFeed" = top stories from every feed
      perFeedStories: 3,
      minRelevance: 3,
      style: "standard",
      language: "English",
      extraInstructions: "",
      ...overrides,
    };
    t.email = { ...DEFAULT_EMAIL, ...(overrides.email || {}) };
    t.schedule = { ...DEFAULT_SCHEDULE, ...(overrides.schedule || {}) };
    return t;
  }

  // Starting points for custom themes. Users edit them freely.
  const TEMPLATES = [
    {
      name: "AI & machine learning",
      color: "#7c3aed",
      interests:
        "New frontier model releases and benchmarks; important AI research papers; AI agents and tooling; " +
        "AI applied to biology, drug discovery and healthcare; AI regulation (EU AI Act, Swiss and US policy); " +
        "major AI company strategy news.",
      avoid:
        "Crypto/NFT; consumer gadget reviews; listicles and 'top 10 prompts' content; small funding rounds under $20M; opinion pieces without new facts.",
      sections: "Models & research, AI in life sciences, Industry & business, Policy & safety",
      keywords: "",
    },
    {
      name: "Immunology & cell therapy",
      color: "#0f766e",
      interests:
        "Immune engineering; CAR-T, TCR-T, CAR-NK and in-vivo CAR approaches; T-cell and B-cell biology; " +
        "cancer immunotherapy and checkpoint inhibitors; autoimmune cell therapies; vaccines and mRNA platforms; " +
        "clinical-trial readouts and FDA/EMA/Swissmedic decisions in these areas; new tools (gene editing, single-cell, synthetic biology) for immune cells.",
      avoid: "General wellness and diet advice; COVID case statistics; press releases with no data.",
      sections: "Research breakthroughs, Clinical & regulatory, Tools & platforms, Industry",
      keywords: "",
    },
    {
      name: "Biotech business (Europe & Switzerland)",
      color: "#b45309",
      interests:
        "Biotech and pharma financing rounds, IPOs, M&A and licensing deals; partnerships between pharma and startups; " +
        "with a focus on Switzerland (Zurich, Basel, Geneva) and Europe; big-pharma pipeline strategy changes; layoffs and site openings.",
      avoid: "Stock-price chatter without news; generic market-outlook articles.",
      sections: "Deals & financing, Switzerland, Europe, Big pharma",
      keywords: "",
    },
  ];

  function mergeSettings(saved) {
    const s = saved || {};
    const out = { ...DEFAULT_SETTINGS, ...s, providers: {} };
    for (const p of Object.keys(PROVIDERS)) {
      out.providers[p] = { ...DEFAULT_SETTINGS.providers[p], ...((s.providers && s.providers[p]) || {}) };
    }
    // v1.0 stored a single Claude key at the top level.
    if (s.apiKey && !out.providers.claude.apiKey) {
      out.providers.claude = { apiKey: s.apiKey, model: s.model || PROVIDERS.claude.model, effort: s.effort ?? PROVIDERS.claude.effort };
      if (!s.provider) out.provider = "claude";
    }
    delete out.apiKey;
    delete out.model;
    delete out.effort;
    if (!PROVIDERS[out.provider]) out.provider = "deepseek";
    return out;
  }

  async function getSettings() {
    const { settings } = await local().get("settings");
    return mergeSettings(settings);
  }

  async function saveSettings(patch) {
    const cur = await getSettings();
    const next = { ...cur, ...patch, providers: { ...cur.providers } };
    if (patch.providers) {
      for (const [p, v] of Object.entries(patch.providers)) next.providers[p] = { ...cur.providers[p], ...v };
    }
    await local().set({ settings: next });
    return next;
  }

  async function saveProvider(provider, patch) {
    return saveSettings({ providers: { [provider]: patch } });
  }

  /** The provider in use plus its key/model/effort. */
  function activeProvider(settings) {
    const id = PROVIDERS[settings.provider] ? settings.provider : "deepseek";
    return { id, label: PROVIDERS[id].label, ...settings.providers[id] };
  }

  function upgradeTopic(t) {
    // Make sure older/partial topic objects get all fields.
    return newTopic({ ...t, id: t.id || RCD.util.uid() });
  }

  async function getTopics() {
    const { topics } = await local().get("topics");
    return Array.isArray(topics) ? topics.map(upgradeTopic) : [];
  }

  async function saveTopics(topics) {
    await local().set({ topics });
  }

  async function getTopic(id) {
    return (await getTopics()).find((t) => t.id === id) || null;
  }

  async function upsertTopic(topic) {
    const topics = await getTopics();
    const i = topics.findIndex((t) => t.id === topic.id);
    if (i >= 0) topics[i] = topic;
    else topics.push(topic);
    await saveTopics(topics);
    return topic;
  }

  async function deleteTopic(id) {
    const topics = (await getTopics()).filter((t) => t.id !== id);
    await saveTopics(topics);
    await local().remove(["state:" + id, "seen:" + id]);
  }

  // Run state lives in its own key so editing a topic never overwrites it.
  async function getState(id) {
    const key = "state:" + id;
    const r = await local().get(key);
    return r[key] || { lastRun: null, lastSuccess: null, lastStatus: "", lastError: "" };
  }

  async function setState(id, patch) {
    const cur = await getState(id);
    const next = { ...cur, ...patch };
    await local().set({ ["state:" + id]: next });
    return next;
  }

  async function getSeen(id) {
    const key = "seen:" + id;
    const r = await local().get(key);
    return Array.isArray(r[key]) ? r[key] : [];
  }

  async function addSeen(id, keys, cap = 5000) {
    const cur = await getSeen(id);
    const set = new Set(cur);
    for (const k of keys) {
      if (!set.has(k)) {
        cur.push(k);
        set.add(k);
      }
    }
    const trimmed = cur.length > cap ? cur.slice(cur.length - cap) : cur;
    await local().set({ ["seen:" + id]: trimmed });
  }

  async function clearSeen(id) {
    await local().remove("seen:" + id);
  }

  async function addHistory(entry, cap = 25) {
    const { history } = await local().get("history");
    const list = Array.isArray(history) ? history : [];
    list.unshift(entry);
    await local().set({ history: list.slice(0, cap) });
  }

  async function getHistory() {
    const { history } = await local().get("history");
    return Array.isArray(history) ? history : [];
  }

  return {
    PROVIDERS,
    DEFAULT_SETTINGS,
    TEMPLATES,
    newTopic,
    getSettings,
    saveSettings,
    saveProvider,
    activeProvider,
    getTopics,
    saveTopics,
    getTopic,
    upsertTopic,
    deleteTopic,
    getState,
    setState,
    getSeen,
    addSeen,
    clearSeen,
    addHistory,
    getHistory,
  };
})();
