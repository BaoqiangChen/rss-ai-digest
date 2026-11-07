"use strict";
// Background page: runs digests on demand and on schedule.
(() => {
  const api = RCD.api;
  const U = RCD.util;
  const store = RCD.store;
  const running = new Map(); // topicId -> progress text

  function broadcast(msg) {
    try {
      const p = api.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      /* no listener open */
    }
  }

  function updateBadge() {
    try {
      const p = api.browserAction.setBadgeText({ text: running.size ? "…" : "" });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  function progress(topicId, text) {
    running.set(topicId, text);
    updateBadge();
    broadcast({ type: "progress", topicId, text });
  }

  async function notify(title, message) {
    const settings = await store.getSettings();
    if (!settings.notify) return;
    try {
      await api.notifications.create({
        type: "basic",
        iconUrl: api.runtime.getURL("icons/icon-64.png"),
        title,
        message: String(message).slice(0, 400),
      });
    } catch (e) {
      /* notifications are optional */
    }
  }

  /**
   * Collect -> ask the AI (DeepSeek or Claude) -> render -> email.
   * preview=true opens the compose window without sending and does not mark articles as seen.
   */
  async function runTopic(topicId, { preview = false, trigger = "manual" } = {}) {
    if (running.has(topicId)) throw new Error("This topic is already running.");
    const topic = await store.getTopic(topicId);
    if (!topic) throw new Error("Topic not found.");
    running.set(topicId, "Starting…");
    const now = new Date();
    try {
      const settings = await store.getSettings();
      const provider = store.activeProvider(settings);
      if (!provider.apiKey) throw new Error(`Add your ${provider.label} API key on the settings page first.`);
      if (!topic.folderIds.length && !U.extractUrls(topic.feedUrls).length)
        throw new Error("This topic has no sources. Pick Thunderbird feed folders or add feed URLs.");

      progress(topicId, "Collecting articles…");
      const since = new Date(now.getTime() - Math.max(1, Number(topic.lookbackHours) || 24) * 3600e3);
      const { items: raw, errors, stats } = await RCD.sources.collect(topic, settings, since, (t) => progress(topicId, t));
      const seen = topic.onlyNew ? new Set(await store.getSeen(topicId)) : new Set();
      const items = RCD.digest.prepareItems(raw, topic, seen);
      const fstats = RCD.digest.feedStats(stats, items);
      const feedLine = RCD.digest.feedSummary(fstats);

      if (!items.length) {
        const status =
          `No new articles in the last ${topic.lookbackHours} h` + (feedLine ? ` (${feedLine})` : errors.length ? ` (${errors.length} source error(s))` : "");
        await store.setState(topicId, {
          lastRun: now.toISOString(),
          lastStatus: status,
          lastError: errors.join("\n"),
          lastFeeds: fstats,
          ...(errors.length ? {} : { lastSuccess: now.toISOString() }),
        });
        if (trigger !== "schedule" || errors.length) notify(topic.name, status + (errors.length ? "\n" + errors[0] : ""));
        return { ok: true, status, sent: false, feeds: fstats };
      }

      progress(topicId, `${provider.label} is reading ${items.length} article(s) from ${fstats.filter((f) => f.sent).length || 1} feed(s)…`);
      const { system, user } = RCD.digest.buildPrompt(topic, items, now);
      const { data, usage, label } = await RCD.ai.generateJson(settings, {
        system,
        user,
        schema: RCD.digest.SCHEMA,
        example: RCD.digest.EXAMPLE,
      });
      const result = RCD.digest.normalizeResult(data, items, topic.minRelevance, {
        perFeed: topic.coverage === "perFeed",
        perFeedStories: Math.max(1, Math.min(20, Number(topic.perFeedStories) || 3)),
      });
      const meta = { now, scanned: items.length, model: label, errors, stats: fstats };

      if (!result.count && !topic.email.sendWhenEmpty && !preview) {
        if (topic.onlyNew) await store.addSeen(topicId, items.map((i) => i.key));
        const status = `Nothing relevant among ${items.length} article(s) — no email sent` + (feedLine ? ` (${feedLine})` : "");
        await store.setState(topicId, { lastRun: now.toISOString(), lastSuccess: now.toISOString(), lastStatus: status, lastError: "", lastFeeds: fstats });
        if (trigger !== "schedule") notify(topic.name, status);
        return { ok: true, status, sent: false, feeds: fstats };
      }

      const html = RCD.digest.renderHtml(topic, result, meta);
      const text = RCD.digest.renderText(topic, result, meta);
      const subject = RCD.digest.subjectFor(topic, now, result.count);

      progress(topicId, preview || topic.email.review ? "Opening email for review…" : "Sending email…");
      const sent = await RCD.mailer.send({
        identityId: topic.email.identityId,
        defaultIdentityId: settings.defaultIdentityId,
        to: topic.email.to,
        subject,
        html,
        text,
        plainText: topic.email.plainText,
        review: preview || topic.email.review,
        silent: settings.silentSend !== false,
      });

      if (!preview && topic.onlyNew) await store.addSeen(topicId, items.map((i) => i.key));

      const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      const verb =
        sent.mode === "review"
          ? "Opened for review"
          : sent.silent || settings.silentSend === false
          ? "Sent"
          : "Sent via compose window";
      const status = `${verb}: ${result.count} stories from ${items.length} articles${feedLine ? ", " + feedLine : ""} → ${sent.to.join(", ")} (${tokens.toLocaleString()} tokens)`;
      if (!preview) {
        await store.setState(topicId, { lastRun: now.toISOString(), lastSuccess: now.toISOString(), lastStatus: status, lastError: errors.join("\n"), lastFeeds: fstats });
        await store.addHistory({ topicId, topicName: topic.name, at: now.toISOString(), subject, count: result.count, scanned: items.length, html });
      }
      if (sent.mode !== "review") notify(topic.name, status);
      return { ok: true, status, sent: sent.mode !== "review", feeds: fstats };
    } catch (e) {
      const msg = U.errMsg(e);
      if (!preview) await store.setState(topicId, { lastRun: now.toISOString(), lastStatus: "Failed", lastError: msg });
      notify(`${topic.name}: digest failed`, msg);
      throw e;
    } finally {
      running.delete(topicId);
      updateBadge();
      broadcast({ type: "progress", topicId, text: "", done: true });
      if (trigger === "schedule") scheduleTopic(topicId).catch(() => {});
    }
  }

  // ---------- scheduling ----------

  const ALARM_PREFIX = "rcd-topic:";

  async function scheduleTopic(topicId) {
    await api.alarms.clear(ALARM_PREFIX + topicId);
    const topic = await store.getTopic(topicId);
    if (!topic) return null;
    const when = RCD.schedule.nextRunTime(topic, await store.getState(topicId), new Date());
    if (when) api.alarms.create(ALARM_PREFIX + topicId, { when: when.getTime() });
    return when;
  }

  async function rescheduleAll() {
    const all = await api.alarms.getAll();
    const topics = await store.getTopics();
    const ids = new Set(topics.map((t) => t.id));
    for (const a of all) {
      if (a.name.startsWith(ALARM_PREFIX) && !ids.has(a.name.slice(ALARM_PREFIX.length))) await api.alarms.clear(a.name);
    }
    for (const t of topics) await scheduleTopic(t.id);
  }

  api.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const id = alarm.name.slice(ALARM_PREFIX.length);
    runTopic(id, { trigger: "schedule" }).catch((e) => console.warn("[RSS AI Digest] scheduled run failed:", e));
  });

  let rescheduleTimer = null;
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.topics) return;
    clearTimeout(rescheduleTimer);
    rescheduleTimer = setTimeout(() => rescheduleAll().catch(console.warn), 500);
  });

  // ---------- messages from the popup / settings page ----------

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return undefined;
    switch (msg.type) {
      case "run":
        return runTopic(msg.topicId, { preview: !!msg.preview }).then(
          (r) => r,
          (e) => ({ ok: false, error: U.errMsg(e) })
        );
      case "status":
        return Promise.resolve({ running: Object.fromEntries(running) });
      case "nextRuns":
        return api.alarms.getAll().then((alarms) => {
          const out = {};
          for (const a of alarms) if (a.name.startsWith(ALARM_PREFIX)) out[a.name.slice(ALARM_PREFIX.length)] = a.scheduledTime;
          return out;
        });
      case "testKey":
        return RCD.ai.listModels(msg.provider || "deepseek", msg.apiKey).then(
          (models) => ({ ok: true, models }),
          (e) => ({ ok: false, error: U.errMsg(e) })
        );
      default:
        return undefined;
    }
  });

  try {
    const p = api.browserAction.setBadgeBackgroundColor({ color: "#0b6bcb" });
    if (p && p.catch) p.catch(() => {});
  } catch (e) {
    /* ignore */
  }

  rescheduleAll().catch((e) => console.warn("[RSS AI Digest] scheduling failed:", e));

  // Exposed for tests / debugging from the add-on inspector.
  globalThis.RCD.bg = { runTopic, rescheduleAll, scheduleTopic, running };
})();
