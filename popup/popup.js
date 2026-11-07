"use strict";
(() => {
  const api = RCD.api;
  const U = RCD.util;
  const store = RCD.store;
  const $ = (id) => document.getElementById(id);
  const statusEls = new Map();
  const buttons = new Map();

  function setStatus(id, text, cls = "") {
    const el = statusEls.get(id);
    if (!el) return;
    el.textContent = text;
    el.className = "status " + cls;
  }

  function setBusy(id, busy) {
    (buttons.get(id) || []).forEach((b) => (b.disabled = busy));
  }

  async function run(id, preview) {
    setBusy(id, true);
    setStatus(id, "Starting…", "muted");
    let r;
    try {
      r = await api.runtime.sendMessage({ type: "run", topicId: id, preview });
    } catch (e) {
      r = { ok: false, error: U.errMsg(e) };
    }
    setBusy(id, false);
    if (r && r.ok) setStatus(id, r.status, "ok");
    else setStatus(id, "Failed: " + ((r && r.error) || "unknown error"), "err");
  }

  async function render() {
    const [settings, topics, status, nextRuns] = await Promise.all([
      store.getSettings(),
      store.getTopics(),
      api.runtime.sendMessage({ type: "status" }).catch(() => ({ running: {} })),
      api.runtime.sendMessage({ type: "nextRuns" }).catch(() => ({})),
    ]);
    const provider = store.activeProvider(settings);
    if (!provider.apiKey) {
      $("setup").hidden = false;
      $("setup").textContent = `Connect ${provider.label} first: open Settings and paste your API key.`;
    }
    $("empty").hidden = topics.length > 0;
    const ul = $("list");
    ul.textContent = "";
    for (const t of topics) {
      const st = await store.getState(t.id);
      const li = document.createElement("li");
      li.style.borderLeftColor = t.color || "#0b6bcb";
      if (!t.enabled) li.classList.add("off");

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = t.name;

      const meta = document.createElement("div");
      meta.className = "meta";
      const bits = [RCD.schedule.describe(t.schedule)];
      if (nextRuns && nextRuns[t.id]) bits.push("next " + U.fmtDate(nextRuns[t.id], true));
      if (st.lastRun) bits.push("last " + U.fmtDate(st.lastRun, true));
      meta.textContent = bits.join(" · ");

      const s = document.createElement("div");
      statusEls.set(t.id, s);

      const btns = document.createElement("div");
      btns.className = "btns";
      const runB = document.createElement("button");
      runB.className = "primary";
      runB.textContent = t.email.review ? "Run (review)" : "Run & send";
      runB.addEventListener("click", () => run(t.id, false));
      const prevB = document.createElement("button");
      prevB.textContent = "Preview";
      prevB.title = "Open the digest in a compose window without sending";
      prevB.addEventListener("click", () => run(t.id, true));
      buttons.set(t.id, [runB, prevB]);
      btns.append(runB, prevB);

      li.append(name, meta, s, btns);
      ul.append(li);

      const running = status && status.running && status.running[t.id];
      if (running) {
        setStatus(t.id, running, "muted");
        setBusy(t.id, true);
      } else if (st.lastStatus) {
        setStatus(t.id, st.lastStatus === "Failed" ? "Failed: " + st.lastError : st.lastStatus, st.lastStatus === "Failed" ? "err" : "muted");
      }
    }
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "progress") {
      if (msg.done) setBusy(msg.topicId, false);
      else if (msg.text) setStatus(msg.topicId, msg.text, "muted");
    }
    return undefined;
  });

  $("settings").addEventListener("click", () => {
    api.runtime.openOptionsPage();
    window.close();
  });

  render().catch((e) => {
    $("empty").hidden = false;
    $("empty").textContent = "Error: " + U.errMsg(e);
  });
})();
