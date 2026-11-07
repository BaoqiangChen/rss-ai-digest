"use strict";
// Sends the digest through one of the user's existing Thunderbird identities.
var RCD = (globalThis.RCD = globalThis.RCD || {});

RCD.mailer = (() => {
  const api = () => RCD.api;
  const SEND_PERMISSION = { permissions: ["messages.send"] };
  const SILENT_MIN_VERSION = 153; // messages.sendMessage() landed in Thunderbird 153

  async function listIdentities() {
    let list = [];
    try {
      if (api().identities && api().identities.list) list = await api().identities.list();
    } catch (e) {
      list = [];
    }
    if (!list.length) {
      const accounts = await api().accounts.list(false);
      for (const a of accounts) for (const i of a.identities || []) list.push({ ...i, accountId: i.accountId || a.id });
    }
    return list
      .filter((i) => i && i.email)
      .map((i) => ({
        id: i.id,
        email: i.email,
        name: i.name || "",
        label: i.label || "",
        accountId: i.accountId || "",
        display: `${i.name ? i.name + " " : ""}<${i.email}>${i.label ? " — " + i.label : ""}`,
      }));
  }

  async function resolveIdentity(preferredId, fallbackId) {
    const ids = await listIdentities();
    return ids.find((i) => i.id === preferredId) || ids.find((i) => i.id === fallbackId) || ids[0] || null;
  }

  async function thunderbirdVersion() {
    try {
      const info = await api().runtime.getBrowserInfo();
      return { name: info.name, version: info.version, major: parseInt(info.version, 10) || 0 };
    } catch (e) {
      return { name: "Thunderbird", version: "", major: 0 };
    }
  }

  /**
   * Can we send in the background (no compose window)?
   * -> { available, granted, version, reason }
   */
  async function silentStatus() {
    const tb = await thunderbirdVersion();
    const hasApi = !!(api().messages && typeof api().messages.sendMessage === "function");
    let granted = false;
    try {
      granted = await api().permissions.contains(SEND_PERMISSION);
    } catch (e) {
      granted = false; // older Thunderbird doesn't know this permission
    }
    const available = hasApi || tb.major >= SILENT_MIN_VERSION;
    let reason = "";
    if (!available) reason = `Needs Thunderbird ${SILENT_MIN_VERSION} or newer (you have ${tb.version || "an older version"}).`;
    else if (!granted) reason = "Thunderbird needs your permission once.";
    return { available, granted, ready: granted && hasApi, version: tb.version, reason };
  }

  /** Must be called directly from a click/change handler (user gesture). */
  function requestSilentPermission() {
    return api().permissions.request(SEND_PERMISSION);
  }

  function wrapHtml(html) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  }

  /**
   * Sends the digest with the identity's normal outgoing server and saved login.
   *  - silent (Thunderbird 153+, permission granted): messages.sendMessage(), no window at all
   *  - otherwise: compose window, minimised straight away, sent and closed automatically
   *  - review=true: compose window stays open for the user
   */
  async function send({ identityId, defaultIdentityId, to, subject, html, text, plainText, review, silent = true }) {
    const identity = await resolveIdentity(identityId, defaultIdentityId);
    if (!identity) throw new Error("No sending identity found. Set up an email account in Thunderbird first.");
    let recipients = RCD.util.parseList(to);
    if (!recipients.length) recipients = [identity.email];
    const base = { from: identity.email, to: recipients };

    if (!review && silent) {
      const st = await silentStatus();
      if (st.ready) {
        const details = { identityId: identity.id, to: recipients, subject };
        if (plainText) {
          details.isPlainText = true;
          details.plainTextBody = text;
        } else {
          details.body = wrapHtml(html);
          details.deliveryFormat = "both"; // HTML plus an automatic plain-text alternative
        }
        const res = await api().messages.sendMessage(details, { mode: "default" });
        return { ...base, mode: (res && res.mode) || "sendNow", silent: true };
      }
    }

    const details = { identityId: identity.id, to: recipients, subject };
    if (plainText) {
      details.isPlainText = true;
      details.plainTextBody = text;
    } else {
      details.isPlainText = false;
      details.body = wrapHtml(html);
    }
    const tab = await api().compose.beginNew(details);
    if (review) return { ...base, mode: "review", silent: false };

    // Keep the fallback as unobtrusive as possible.
    try {
      if (tab && tab.windowId != null && api().windows) await api().windows.update(tab.windowId, { state: "minimized" });
    } catch (e) {
      /* ignore */
    }
    const res = await api().compose.sendMessage(tab.id, { mode: "default" });
    return { ...base, mode: (res && res.mode) || "sendNow", silent: false };
  }

  return { listIdentities, resolveIdentity, send, silentStatus, requestSilentPermission, thunderbirdVersion, SILENT_MIN_VERSION };
})();
