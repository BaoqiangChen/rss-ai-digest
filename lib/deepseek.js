"use strict";
// DeepSeek client (OpenAI-compatible Chat Completions API at https://api.deepseek.com).
var RCD = (globalThis.RCD = globalThis.RCD || {});

RCD.deepseek = (() => {
  const BASE = "https://api.deepseek.com";

  class DeepSeekError extends Error {
    constructor(message, { status = 0, type = "", retryAfter = null } = {}) {
      super(message);
      this.name = "DeepSeekError";
      this.status = status;
      this.type = type;
      this.retryAfter = retryAfter;
    }
  }

  const HINTS = {
    401: "check the API key on the settings page",
    402: "your DeepSeek balance is empty — top up at platform.deepseek.com",
    429: "rate limit reached, try again shortly",
    503: "DeepSeek is overloaded, try again shortly",
  };

  async function request(path, { apiKey, method = "GET", body, timeoutMs = 300000 }) {
    if (!apiKey) throw new DeepSeekError("No DeepSeek API key set. Add it on the add-on's settings page.");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw new DeepSeekError("DeepSeek request timed out.", { type: "timeout" });
      throw new DeepSeekError("Could not reach the DeepSeek API: " + RCD.util.errMsg(e), { type: "network" });
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
      const err = data && data.error;
      const msg = (err && (err.message || err.msg)) || (typeof err === "string" ? err : "") || text || res.statusText;
      const hint = HINTS[res.status] ? ` (${HINTS[res.status]})` : "";
      const ra = Number(res.headers.get("retry-after"));
      throw new DeepSeekError(`DeepSeek API ${res.status}: ${msg}${hint}`, {
        status: res.status,
        type: (err && err.type) || "",
        retryAfter: isFinite(ra) && ra > 0 ? ra : null,
      });
    }
    return data;
  }

  function retryable(e) {
    return e && (e.type === "network" || e.type === "timeout" || e.type === "busy" || [408, 429, 500, 502, 503, 504].includes(e.status));
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

  async function listModels(apiKey) {
    const data = await request("/models", { apiKey, timeoutMs: 30000 });
    return (data && Array.isArray(data.data) ? data.data : []).map((m) => ({ id: m.id, name: m.name || m.id }));
  }

  /**
   * Ask DeepSeek for a JSON object. DeepSeek's JSON mode guarantees valid JSON but not a schema,
   * so the prompt carries an example and the schema; the caller validates the result.
   * effort: "none" disables thinking; "low" | "high" | "max" enable it.
   */
  async function generateJson({ apiKey, model, effort, maxTokens, system, user, schema, example }) {
    const opts = { thinking: !!effort, format: true };
    const jsonGuide =
      "\n\nReturn a single json object only (no prose, no code fences). Use exactly this structure — " +
      "the values below are illustrative:\n" +
      JSON.stringify(example || {}, null, 1) +
      (schema ? "\n\nJSON schema of the object:\n" + JSON.stringify(schema) : "");
    let emptyRetries = 1;
    let busyRetries = 2;

    for (let attempt = 0; attempt < 6; attempt++) {
      const body = {
        model,
        max_tokens: maxTokens || 16000,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user + jsonGuide },
        ],
      };
      if (opts.format) body.response_format = { type: "json_object" };
      if (opts.thinking) {
        if (effort === "none") body.thinking = { type: "disabled" };
        else {
          body.thinking = { type: "enabled" };
          body.reasoning_effort = effort;
        }
      }

      let resp;
      try {
        resp = await withRetry(() => request("/chat/completions", { apiKey, method: "POST", body }));
      } catch (e) {
        const m = String(e.message || "");
        if ((e.status === 400 || e.status === 422) && opts.thinking && /(thinking|reasoning)/i.test(m)) {
          opts.thinking = false;
          continue;
        }
        if ((e.status === 400 || e.status === 422) && opts.format && /(response_format|json)/i.test(m)) {
          opts.format = false;
          continue;
        }
        throw e;
      }

      const choice = resp && resp.choices && resp.choices[0];
      const finish = choice && choice.finish_reason;
      if (finish === "length")
        throw new DeepSeekError(
          "DeepSeek's answer was cut off (max output tokens reached). Raise 'Max output tokens' in Settings or lower 'Max articles' for this topic."
        );
      if (finish === "content_filter") throw new DeepSeekError("DeepSeek's content filter blocked the answer.");
      if (finish === "insufficient_system_resource" && busyRetries-- > 0) {
        await RCD.util.sleep(5000);
        continue;
      }
      const content = (choice && choice.message && choice.message.content) || "";
      if (!content.trim()) {
        // JSON mode can return blank content when the model's output wasn't valid JSON; retry once.
        if (emptyRetries-- > 0) continue;
        throw new DeepSeekError("DeepSeek returned an empty answer. Try again, or switch thinking effort.");
      }
      const u = resp.usage || {};
      return {
        data: RCD.util.parseJsonLoose(content),
        usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
        model: resp.model || model,
      };
    }
    throw new DeepSeekError("DeepSeek request failed after retries.");
  }

  return { DeepSeekError, listModels, generateJson, request };
})();
