"use strict";
(() => {
  const api = RCD.api;
  const U = RCD.util;
  const store = RCD.store;
  const $ = (id) => document.getElementById(id);

  let topics = [];
  let current = null; // topic being edited
  let dirty = false;
  let folderTree = [];
  let identities = [];
  let nextRuns = {};
  const ALL_ORIGINS = { origins: ["<all_urls>"] };

  // ---------- helpers ----------
  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms);
  }
  function setStatus(el, text, cls = "") {
    el.textContent = text;
    el.className = "status " + cls;
  }
  function send(msg) {
    return api.runtime.sendMessage(msg);
  }

  // ---------- 1. AI provider connection ----------
  const modelCache = {}; // provider id -> models returned by the API
  const providerId = () => $("provider").value;
  const meta = (id) => store.PROVIDERS[id];

  function fillModels(models, selected, id) {
    const sel = $("model");
    sel.textContent = "";
    const def = meta(id).model;
    let list = models.slice();
    if (!list.length) list = [{ id: selected || def, name: selected || def }];
    if (selected && !list.some((m) => m.id === selected)) list.unshift({ id: selected, name: selected + " (saved)" });
    for (const m of list) sel.add(new Option(m.name && m.name !== m.id ? `${m.name}  ·  ${m.id}` : m.id, m.id));
    sel.value = selected && list.some((m) => m.id === selected) ? selected : list[0].id;
  }

  function fillEffort(id, value) {
    const sel = $("effort");
    sel.textContent = "";
    for (const [v, label] of meta(id).efforts) sel.add(new Option(label, v));
    sel.value = meta(id).efforts.some(([v]) => v === value) ? value : meta(id).effort;
  }

  async function showProvider(id, { check = true } = {}) {
    const s = await store.getSettings();
    const p = s.providers[id];
    const m = meta(id);
    $("provider").value = id;
    $("keyLabel").textContent = `${m.label} API key`;
    $("apiKey").value = p.apiKey;
    $("apiKey").placeholder = m.keyPlaceholder;
    $("keyHint").textContent = m.hint;
    $("keyLink").href = m.keyUrl;
    fillEffort(id, p.effort);
    fillModels(modelCache[id] || [], p.model, id);
    setStatus($("connStatus"), p.apiKey ? "Checking…" : "Not connected. Paste your key and click Connect.", "muted");
    if (p.apiKey && check) connect(true);
  }

  async function connect(quiet = false) {
    const id = providerId();
    const m = meta(id);
    const key = $("apiKey").value.trim();
    if (!key) {
      setStatus($("connStatus"), "Paste your API key, then click Connect.", "err");
      return;
    }
    setStatus($("connStatus"), "Connecting…", "muted");
    $("connect").disabled = true;
    let r;
    try {
      r = await send({ type: "testKey", provider: id, apiKey: key });
    } catch (e) {
      r = { ok: false, error: U.errMsg(e) };
    }
    $("connect").disabled = false;
    if (providerId() !== id) return; // user switched provider meanwhile
    if (!r || !r.ok) {
      setStatus($("connStatus"), "Connection failed: " + ((r && r.error) || "no response from background"), "err");
      return;
    }
    await store.saveProvider(id, { apiKey: key });
    modelCache[id] = r.models;
    const s = await store.getSettings();
    const saved = s.providers[id].model;
    fillModels(r.models, saved, id);
    if (r.models.length && !r.models.some((x) => x.id === saved)) {
      setStatus($("connStatus"), `Connected ✓ — but saved model “${saved}” isn't offered to this key. Pick another model.`, "err");
    } else {
      setStatus($("connStatus"), `Connected to ${m.label} ✓ — ${r.models.length} model(s) available.`, "ok");
    }
    if (!quiet) toast(`${m.label} connected`);
  }

  async function loadSettings() {
    const s = await store.getSettings();
    $("maxTokens").value = s.maxTokens;
    $("maxChars").value = s.maxCharsPerArticle;
    $("notify").checked = !!s.notify;
    await showProvider(s.provider);
  }

  function bindSettings() {
    $("connect").addEventListener("click", () => connect(false));
    $("apiKey").addEventListener("keydown", (e) => e.key === "Enter" && connect(false));
    $("toggleKey").addEventListener("click", () => {
      const k = $("apiKey");
      k.type = k.type === "password" ? "text" : "password";
      $("toggleKey").textContent = k.type === "password" ? "Show" : "Hide";
    });
    const saved = () => toast("Settings saved", 1200);
    const save = (patch) => store.saveSettings(patch).then(saved);
    $("provider").addEventListener("change", async () => {
      const id = providerId();
      await store.saveSettings({ provider: id });
      await showProvider(id);
      toast(`Digests will now use ${meta(id).label}`);
    });
    $("apiKey").addEventListener("change", () => store.saveProvider(providerId(), { apiKey: $("apiKey").value.trim() }));
    $("model").addEventListener("change", () => store.saveProvider(providerId(), { model: $("model").value }).then(saved));
    $("effort").addEventListener("change", () => store.saveProvider(providerId(), { effort: $("effort").value }).then(saved));
    $("maxTokens").addEventListener("change", () =>
      save({ maxTokens: Math.max(2000, Math.min(128000, Number($("maxTokens").value) || 16000)) })
    );
    $("maxChars").addEventListener("change", () =>
      save({ maxCharsPerArticle: Math.max(200, Math.min(20000, Number($("maxChars").value) || 1500)) })
    );
    $("notify").addEventListener("change", () => save({ notify: $("notify").checked }));
    $("defaultIdentity").addEventListener("change", () => save({ defaultIdentityId: $("defaultIdentity").value }));
    $("grantSilent").addEventListener("click", () => {
      // Called synchronously inside the click handler (user gesture).
      RCD.mailer.requestSilentPermission().then(
        (ok) => {
          if (!ok) toast("Permission not granted — the compose window will be used.", 3500);
          updateSilent();
        },
        (e) => {
          toast("Could not request permission: " + U.errMsg(e), 4000);
          updateSilent();
        }
      );
    });
    $("silentSend").addEventListener("change", () => {
      const on = $("silentSend").checked;
      const permP = on ? RCD.mailer.requestSilentPermission().catch(() => false) : null;
      store.saveSettings({ silentSend: on }).then(async () => {
        if (permP && !(await permP)) toast("Permission not granted — the compose window will be used.", 3500);
        else toast(on ? "Silent sending on" : "Silent sending off", 1500);
        updateSilent();
      });
    });
    $("grantPerm").addEventListener("click", () => {
      // Must be called synchronously inside the click handler.
      api.permissions.request(ALL_ORIGINS).then(updatePerm, updatePerm);
    });
  }

  async function updateSilent() {
    let st;
    try {
      st = await RCD.mailer.silentStatus();
    } catch (e) {
      st = { available: false, granted: false, reason: U.errMsg(e) };
    }
    const s = await store.getSettings();
    const on = s.silentSend !== false;
    $("silentSend").checked = on && st.available;
    $("silentSend").disabled = !st.available;
    let text;
    let cls = "muted";
    if (!st.available) text = st.reason + " Until then the compose window opens minimised and closes by itself.";
    else if (!on) text = "Off — a minimised compose window is used while sending.";
    else if (st.granted) {
      text = "Enabled ✓ — digests are sent without opening any window.";
      cls = "status ok";
    } else text = "Click Allow — Thunderbird asks once for permission to send on your behalf.";
    $("silentStatus").textContent = text;
    $("silentStatus").className = cls;
    $("grantSilent").hidden = !(st.available && on && !st.granted);
  }

  async function updatePerm() {
    let has = false;
    try {
      has = await api.permissions.contains(ALL_ORIGINS);
    } catch (e) {
      has = false;
    }
    $("permStatus").textContent = has ? "Allowed ✓" : "Not allowed yet";
    $("permStatus").className = has ? "status ok" : "muted";
    $("grantPerm").hidden = has;
    return has;
  }

  // ---------- 2. identities ----------
  async function loadIdentities() {
    try {
      identities = await RCD.mailer.listIdentities();
    } catch (e) {
      identities = [];
    }
    const s = await store.getSettings();
    const def = $("defaultIdentity");
    def.textContent = "";
    if (!identities.length) def.add(new Option("No email identities found", ""));
    for (const i of identities) def.add(new Option(i.display, i.id));
    def.value = identities.some((i) => i.id === s.defaultIdentityId) ? s.defaultIdentityId : identities[0] ? identities[0].id : "";
    if (identities.length && def.value !== s.defaultIdentityId) await store.saveSettings({ defaultIdentityId: def.value });

    const ti = $("t_identity");
    ti.textContent = "";
    ti.add(new Option("Default sender (from Sending)", ""));
    for (const i of identities) ti.add(new Option(i.display, i.id));
  }

  // ---------- 3. topics ----------
  async function refreshNextRuns() {
    try {
      nextRuns = (await send({ type: "nextRuns" })) || {};
    } catch (e) {
      nextRuns = {};
    }
  }

  async function renderTopicList() {
    const ul = $("topicList");
    ul.textContent = "";
    for (const t of topics) {
      const li = document.createElement("li");
      li.style.borderLeftColor = t.color || "#0b6bcb";
      if (current && current.id === t.id) li.classList.add("active");
      if (!t.enabled) li.classList.add("off");
      const name = document.createElement("span");
      name.textContent = t.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      const st = await store.getState(t.id);
      const sched = RCD.schedule.describe(t.schedule);
      meta.textContent = sched + (st.lastStatus ? " · " + (st.lastStatus === "Failed" ? "⚠ failed" : "last " + U.fmtDate(st.lastRun)) : "");
      li.append(name, meta);
      li.addEventListener("click", () => selectTopic(t.id));
      ul.append(li);
    }
    $("emptyEditor").hidden = !!current;
    $("editor").hidden = !current;
  }

  function renderTemplates() {
    const box = $("templates");
    for (const tpl of store.TEMPLATES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ghost";
      b.textContent = tpl.name;
      b.style.borderLeft = `4px solid ${tpl.color}`;
      b.addEventListener("click", () => createTopic(tpl));
      box.append(b);
    }
  }

  function renderDays() {
    const box = $("t_days");
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
      const l = document.createElement("label");
      const c = document.createElement("input");
      c.type = "checkbox";
      c.value = String(d);
      l.append(c, " " + RCD.schedule.DAY_NAMES[d]);
      box.append(l);
    }
  }

  function renderFolderTree() {
    const box = $("folderTree");
    box.textContent = "";
    const selected = new Set(current ? current.folderIds : []);
    const rss = folderTree.filter((a) => a.type === "rss");
    const other = folderTree.filter((a) => a.type !== "rss");

    const renderAccount = (acc, parent) => {
      const head = document.createElement("div");
      head.className = "acct";
      head.textContent = acc.accountName;
      const all = document.createElement("button");
      all.type = "button";
      all.className = "ghost";
      all.textContent = "all";
      all.addEventListener("click", () => {
        const boxes = parent.querySelectorAll(`input[data-acct="${CSS.escape(acc.accountId)}"]`);
        const allOn = [...boxes].every((b) => b.checked);
        boxes.forEach((b) => (b.checked = !allOn));
        markDirty();
      });
      if (acc.folders.length) head.append(all);
      parent.append(head);
      if (!acc.folders.length) {
        const p = document.createElement("div");
        p.className = "muted small";
        p.textContent = "(no folders)";
        parent.append(p);
      }
      for (const f of acc.folders) {
        const l = document.createElement("label");
        l.style.paddingLeft = 6 + f.depth * 16 + "px";
        const c = document.createElement("input");
        c.type = "checkbox";
        c.dataset.folder = f.id;
        c.dataset.acct = acc.accountId;
        c.checked = selected.has(f.id);
        l.append(c, " " + f.name);
        parent.append(l);
      }
    };

    if (!rss.length) {
      const p = document.createElement("div");
      p.className = "muted";
      p.textContent = "No Feeds account yet. In Thunderbird use File ▸ New ▸ Feed Account… to subscribe, or paste feed URLs below.";
      box.append(p);
    }
    rss.forEach((a) => renderAccount(a, box));
    if (other.length) {
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = "Mail accounts (e.g. newsletter folders)";
      det.append(sum);
      other.forEach((a) => renderAccount(a, det));
      if (other.some((a) => a.folders.some((f) => selected.has(f.id)))) det.open = true;
      box.append(det);
    }
  }

  function showSchedFields() {
    const type = $("t_schedType").value;
    document.querySelectorAll("[data-sched]").forEach((el) => {
      el.style.display = el.dataset.sched === type ? "" : "none";
    });
  }

  function showCoverageFields() {
    const cov = $("t_coverage").value;
    document.querySelectorAll("[data-cov]").forEach((el) => {
      el.style.visibility = el.dataset.cov === cov ? "" : "hidden";
    });
  }

  function fillEditor(t) {
    $("t_name").value = t.name;
    $("t_color").value = /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : "#0b6bcb";
    $("t_enabled").checked = !!t.enabled;
    $("t_interests").value = t.interests;
    $("t_avoid").value = t.avoid;
    $("t_sections").value = t.sections;
    $("t_keywords").value = t.keywords;
    $("t_feedUrls").value = (t.feedUrls || []).join("\n");
    $("t_lookback").value = t.lookbackHours;
    $("t_maxArticles").value = t.maxArticles;
    $("t_onlyNew").checked = !!t.onlyNew;
    $("t_style").value = t.style;
    $("t_language").value = t.language;
    $("t_minRelevance").value = String(t.minRelevance);
    $("t_coverage").value = t.coverage === "perFeed" ? "perFeed" : "interests";
    $("t_perFeed").value = t.perFeedStories;
    showCoverageFields();
    $("t_extra").value = t.extraInstructions;
    $("t_identity").value = identities.some((i) => i.id === t.email.identityId) ? t.email.identityId : "";
    $("t_to").value = t.email.to;
    $("t_subject").value = t.email.subject;
    $("t_review").checked = !!t.email.review;
    $("t_plainText").checked = !!t.email.plainText;
    $("t_sendWhenEmpty").checked = !!t.email.sendWhenEmpty;
    $("t_schedType").value = t.schedule.type;
    $("t_time").value = t.schedule.time;
    $("t_hours").value = t.schedule.hours;
    const days = new Set((t.schedule.days || []).map(String));
    $("t_days").querySelectorAll("input").forEach((c) => (c.checked = days.has(c.value)));
    showSchedFields();
    renderFolderTree();
  }

  function num(id, min, max, def) {
    const v = Number($(id).value);
    return isFinite(v) && v > 0 ? Math.max(min, Math.min(max, Math.round(v))) : def;
  }

  function readEditor() {
    const t = { ...current };
    t.name = $("t_name").value.trim() || "Untitled topic";
    t.color = $("t_color").value;
    t.enabled = $("t_enabled").checked;
    t.interests = $("t_interests").value.trim();
    t.avoid = $("t_avoid").value.trim();
    t.sections = $("t_sections").value.trim();
    t.keywords = $("t_keywords").value.trim();
    // Keep selections for folders that aren't currently listed (e.g. account temporarily offline).
    const listed = new Set([...$("folderTree").querySelectorAll("input[data-folder]")].map((c) => c.dataset.folder));
    const keep = (current.folderIds || []).filter((id) => !listed.has(id));
    const checked = [...$("folderTree").querySelectorAll("input[data-folder]:checked")].map((c) => c.dataset.folder);
    t.folderIds = [...new Set(keep.concat(checked))];
    t.feedUrls = U.extractUrls($("t_feedUrls").value);
    t.lookbackHours = num("t_lookback", 1, 720, 24);
    t.maxArticles = num("t_maxArticles", 5, 400, 80);
    t.onlyNew = $("t_onlyNew").checked;
    t.style = $("t_style").value;
    t.language = $("t_language").value.trim() || "English";
    t.minRelevance = Number($("t_minRelevance").value) || 3;
    t.coverage = $("t_coverage").value;
    t.perFeedStories = num("t_perFeed", 1, 20, 3);
    t.extraInstructions = $("t_extra").value.trim();
    t.email = {
      ...current.email,
      identityId: $("t_identity").value,
      to: $("t_to").value.trim(),
      subject: $("t_subject").value.trim() || "{topic} digest – {date}",
      review: $("t_review").checked,
      plainText: $("t_plainText").checked,
      sendWhenEmpty: $("t_sendWhenEmpty").checked,
    };
    t.schedule = {
      ...current.schedule,
      type: $("t_schedType").value,
      time: $("t_time").value || "07:30",
      hours: num("t_hours", 1, 168, 6),
      days: [...$("t_days").querySelectorAll("input:checked")].map((c) => Number(c.value)),
    };
    return t;
  }

  function markDirty() {
    if (!current) return;
    dirty = true;
    setStatus($("topicStatus"), "Unsaved changes", "muted");
  }

  async function showTopicState() {
    if (!current) return;
    const st = await store.getState(current.id);
    const lines = [];
    if (st.lastRun) lines.push(`Last run ${U.fmtDate(st.lastRun, true)} — ${st.lastStatus || ""}`);
    if (st.lastError) lines.push((st.lastStatus === "Failed" ? "Error: " : "Warnings: ") + st.lastError);
    if (Array.isArray(st.lastFeeds) && st.lastFeeds.length) {
      lines.push(`Feeds in last run (${st.lastFeeds.length}):`);
      for (const f of st.lastFeeds) lines.push(`  • ${f.name} — ${RCD.digest ? RCD.digest.feedStatusText(f) : f.sent + " read"}`);
    }
    const nr = nextRuns[current.id];
    if (nr) lines.push(`Next scheduled run: ${U.fmtDate(nr, true)}`);
    setStatus($("topicStatus"), lines.join("\n") || "Not run yet.", st.lastStatus === "Failed" ? "err" : "muted");
  }

  async function selectTopic(id) {
    if (dirty && current && current.id !== id && !confirm("Discard unsaved changes to this topic?")) return;
    current = topics.find((t) => t.id === id) || null;
    dirty = false;
    await renderTopicList();
    if (current) {
      fillEditor(current);
      await showTopicState();
    }
  }

  async function createTopic(template) {
    if (dirty && !confirm("Discard unsaved changes to the current topic?")) return;
    dirty = false;
    const t = store.newTopic(template ? { ...template } : { name: "New topic" });
    await store.upsertTopic(t);
    topics = await store.getTopics();
    await selectTopic(t.id);
    $("t_name").focus();
    toast(template ? `Created “${t.name}” — pick its sources, then Save` : "Topic created — describe your interests, then Save");
  }

  async function saveTopic({ quiet = false } = {}) {
    if (!current) return null;
    const t = readEditor();
    await store.upsertTopic(t);
    topics = await store.getTopics();
    current = topics.find((x) => x.id === t.id);
    $("t_feedUrls").value = current.feedUrls.join("\n");
    dirty = false;
    await refreshNextRunsSoon();
    await renderTopicList();
    await showTopicState();
    if (!quiet) toast("Topic saved");
    return current;
  }

  async function refreshNextRunsSoon() {
    // Background reschedules ~0.5 s after the topics change.
    await U.sleep(800);
    await refreshNextRuns();
  }

  function needsWebAccess() {
    return U.extractUrls($("t_feedUrls").value).length > 0;
  }

  async function runCurrent(preview) {
    if (!current) return;
    const permP = needsWebAccess() ? api.permissions.request(ALL_ORIGINS).catch(() => false) : null;
    if (dirty) await saveTopic({ quiet: true });
    if (permP && !(await permP)) toast("Feed URLs need website access (Sending ▸ Allow). Folder sources still work.", 4000);
    updatePerm();
    const id = current.id;
    ["run", "preview"].forEach((b) => ($(b).disabled = true));
    setStatus($("topicStatus"), "Starting…", "muted");
    let r;
    try {
      r = await send({ type: "run", topicId: id, preview });
    } catch (e) {
      r = { ok: false, error: U.errMsg(e) };
    }
    ["run", "preview"].forEach((b) => ($(b).disabled = false));
    if (current && current.id === id) {
      if (r && r.ok) setStatus($("topicStatus"), r.status, "ok");
      else setStatus($("topicStatus"), "Failed: " + ((r && r.error) || "unknown error"), "err");
    }
    await renderTopicList();
  }

  function bindEditor() {
    const form = $("editor");
    form.addEventListener("submit", (e) => e.preventDefault());
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    $("t_schedType").addEventListener("change", showSchedFields);
    $("t_coverage").addEventListener("change", showCoverageFields);
    $("newTopic").addEventListener("click", () => createTopic(null));
    $("save").addEventListener("click", () => {
      // Ask for website access synchronously (user gesture) when feed URLs are used.
      const permP = needsWebAccess() ? api.permissions.request(ALL_ORIGINS).catch(() => false) : null;
      saveTopic().then(async () => {
        if (permP && !(await permP)) toast("Saved. Feed URLs need website access (Sending ▸ Allow).", 4000);
        updatePerm();
      });
    });
    $("run").addEventListener("click", () => runCurrent(false));
    $("preview").addEventListener("click", () => runCurrent(true));
    $("resetSeen").addEventListener("click", async () => {
      if (!current) return;
      await store.clearSeen(current.id);
      toast("Memory cleared — the next run may include articles from earlier digests.");
    });
    $("delete").addEventListener("click", async () => {
      if (!current || !confirm(`Delete topic “${current.name}”?`)) return;
      await store.deleteTopic(current.id);
      topics = await store.getTopics();
      current = null;
      dirty = false;
      await renderTopicList();
      if (topics[0]) selectTopic(topics[0].id);
    });
    window.addEventListener("beforeunload", (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "progress" && current && msg.topicId === current.id && msg.text) {
      setStatus($("topicStatus"), msg.text, "muted");
    }
    return undefined;
  });

  // ---------- init ----------
  async function init() {
    bindSettings();
    bindEditor();
    renderTemplates();
    renderDays();
    await loadSettings();
    await loadIdentities();
    updatePerm();
    updateSilent();
    try {
      folderTree = await RCD.sources.listFolderTree();
    } catch (e) {
      folderTree = [];
      $("folderTree").textContent = "Could not list folders: " + U.errMsg(e);
    }
    await refreshNextRuns();
    topics = await store.getTopics();
    await renderTopicList();
    if (topics.length) await selectTopic(topics[0].id);
  }

  init().catch((e) => {
    console.error(e);
    toast("Error: " + U.errMsg(e), 6000);
  });
})();
