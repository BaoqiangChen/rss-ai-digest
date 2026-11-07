"use strict";
// Minimal Claude (Anthropic Messages API) client for use inside Thunderbird.
var RCD = (globalThis.RCD = globalThis.RCD || {});

RCD.claude = (() => {
  const BASE = "https://api.anthropic.com/v1";

  class ClaudeError extends Error {
    constructor(message, { status = 0, type = "", retryAfter = null } = {}) {
      super(message);
      this.name = "ClaudeError";
      this.status = status;
      this.type = type;
      this.retryAfter = retryAfter;
    }
  }

  function headers(apiKey) {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      // Requests from an add-on carry a moz-extension:// Origin header; this opts in to that.
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }

  async function request(path, { apiKey, method = "GET", body, timeoutMs = 300000 }) {
    if (!apiKey) throw new ClaudeError("No Claude API key set. Add it on the add-on's settings page.");
    // (Only used when "Claude" is chosen as the AI provider in Settings.)
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: headers(apiKey),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw new ClaudeError("Claude API request timed out.", { type: "timeout" });
      throw new ClaudeError("Could not reach the Claude API: " + RCD.util.errMsg(e), { type: "network" });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || text || res.statusText;
      const ra = Number(res.headers.get("retry-after"));
      throw new ClaudeError(`Claude API ${res.status}: ${msg}`, {
        status: res.status,
        type: (data && data.error && data.error.type) || "",
        retryAfter: isFinite(ra) && ra > 0 ? ra : null,
      });
    }
    return data;
  }

  function retryable(e) {
    return e && (e.type === "network" || e.type === "timeout" || [408, 409, 429, 500, 502, 503, 504, 529].includes(e.status));
  }

  async function withRetry(fn, tries = 4) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (!retryable(e) || i === tries - 1) throw e;
        const wait = e.retryAfter ? e.retryAfter * 1000 : Math.min(30000, 2000 * 2 ** i) + Math.random() * 1000;
        await RCD.util.sleep(wait);
      }
    }
    throw lastErr;
  }

  // Used by the settings page as the "log in / test connection" step.
  async function listModels(apiKey) {
    const data = await request("/models?limit=100", { apiKey, timeoutMs: 30000 });
    return (data && Array.isArray(data.data) ? data.data : []).map((m) => ({
      id: m.id,
      name: m.display_name || m.id,
      created: m.created_at || "",
    }));
  }

  function textOf(resp) {
    return (resp && Array.isArray(resp.content) ? resp.content : [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  const parseJsonLoose = (t) => RCD.util.parseJsonLoose(t);

  /**
   * Ask Claude for a JSON object matching `schema`.
   * Uses structured outputs (output_config.format). If the chosen model or account
   * rejects a parameter (e.g. an older model without `effort`), retries without it.
   */
  async function generateJson({ apiKey, model, effort, maxTokens, system, user, schema }) {
    const opts = { effort: !!effort, format: true };
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = {
        model,
        max_tokens: maxTokens || 16000,
        system,
        messages: [{ role: "user", content: user }],
      };
      const oc = {};
      if (opts.effort) oc.effort = effort;
      if (opts.format) oc.format = { type: "json_schema", schema };
      if (Object.keys(oc).length) body.output_config = oc;
      if (!opts.format) {
        body.messages[0].content =
          user +
          "\n\nRespond with ONLY a JSON object (no prose, no code fences) that matches this JSON schema:\n" +
          JSON.stringify(schema);
      }

      let resp;
      try {
        resp = await withRetry(() => request("/messages", { apiKey, method: "POST", body }));
      } catch (e) {
        const m = String(e.message || "");
        if (e.status === 400 && opts.effort && /effort/i.test(m)) {
          opts.effort = false;
          continue;
        }
        if (e.status === 400 && opts.format && /(output_config|format|schema|json)/i.test(m)) {
          opts.format = false;
          continue;
        }
        throw e;
      }

      if (resp.stop_reason === "refusal") throw new ClaudeError("Claude declined to produce this digest.");
      if (resp.stop_reason === "max_tokens")
        throw new ClaudeError(
          "Claude's answer was cut off (max output tokens reached). Raise 'Max output tokens' in Settings or lower 'Max articles' for this topic."
        );
      const data = parseJsonLoose(textOf(resp));
      return { data, usage: resp.usage || {}, model: resp.model || model };
    }
    throw new ClaudeError("Claude request failed after retries.");
  }

  return { ClaudeError, listModels, generateJson, parseJsonLoose, textOf, request };
})();
