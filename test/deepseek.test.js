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

function dsResponse(content, finish = "stop") {
  return {
    id: "c1",
    object: "chat.completion",
    model: "deepseek-flash",
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", reasoning_content: "thinking…", content } }],
    usage: { prompt_tokens: 900, completion_tokens: 250 },
  };
}

test("settings: DeepSeek is the default; v1.0 Claude settings migrate", async () => {
  const env = makeMessenger();
  const R = load(LIB, env);
  let s = await R.store.getSettings();
  assert.equal(s.provider, "deepseek");
  assert.equal(R.store.activeProvider(s).model, "deepseek-flash");
  assert.equal(R.store.activeProvider(s).effort, "low");

  // simulate v1.0 storage
  await env.messenger.storage.local.set({ settings: { apiKey: "sk-ant-old", model: "claude-opus-5-5", effort: "high", maxTokens: 20000 } });
  s = await R.store.getSettings();
  assert.equal(s.provider, "claude");
  assert.equal(s.providers.claude.apiKey, "sk-ant-old");
  assert.equal(s.providers.claude.model, "claude-opus-5-5");
  assert.equal(s.maxTokens, 20000);
  assert.equal(s.apiKey, undefined);

  // switching provider keeps both keys
  await R.store.saveSettings({ provider: "deepseek" });
  await R.store.saveProvider("deepseek", { apiKey: "sk-ds" });
  s = await R.store.getSettings();
  assert.equal(R.store.activeProvider(s).apiKey, "sk-ds");
  assert.equal(s.providers.claude.apiKey, "sk-ant-old");
});

test("end-to-end with DeepSeek: request shape, email footer", async () => {
  const now = Date.now();
  const env = makeMessenger({
    feedMessages: [
      { id: 1, folderId: "account1://Nature", subject: "T-cell atlas", author: "", date: new Date(now - 1000).toISOString(), link: "https://n/atlas", html: "<p>atlas</p>" },
      { id: 2, folderId: "account1://Nature", subject: "Pottery", author: "", date: new Date(now - 2000).toISOString(), link: "https://n/pot", html: "<p>pot</p>" },
    ],
  });
  const R = load(LIB.concat(["background.js"]), env);
  let req;
  mockFetch(env, async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    req = { headers: init.headers, body: JSON.parse(init.body) };
    const ids = [...req.body.messages[1].content.matchAll(/<article id="(\d+)">\nsource: [^\n]*\ntitle: ([^\n]*)/g)];
    const atlas = +ids.find((m) => /atlas/.test(m[2]))[1];
    // DeepSeek JSON mode: valid JSON but loose typing (string id, "items" key, no related_ids)
    return {
      status: 200,
      body: dsResponse(JSON.stringify({ takeaways: ["Atlas out"], sections: [{ title: "Research", items: [{ id: String(atlas), relevance: "5", headline: "T-cell atlas", summary: "S", why_it_matters: "W" }] }], note: "1 skipped" })),
    };
  });
  await R.store.saveProvider("deepseek", { apiKey: "sk-ds" });
  const t = R.store.newTopic({ name: "Immuno", folderIds: ["account1://Nature"] });
  await R.store.upsertTopic(t);
  const r = await R.bg.runTopic(t.id);
  assert.equal(r.ok, true);
  assert.equal(r.sent, true);

  assert.equal(req.headers.Authorization, "Bearer sk-ds");
  assert.equal(req.body.model, "deepseek-flash");
  assert.deepEqual(req.body.response_format, { type: "json_object" });
  assert.deepEqual(req.body.thinking, { type: "enabled" });
  assert.equal(req.body.reasoning_effort, "low");
  assert.equal(req.body.stream, false);
  assert.equal(req.body.messages[0].role, "system");
  assert.match(req.body.messages[1].content, /json object/);
  assert.match(req.body.messages[1].content, /"why_it_matters"/);

  const mail = env.calls.beginNew[0];
  assert.match(mail.body, /T-cell atlas/);
  assert.match(mail.body, /Summarised by DeepSeek deepseek-flash via RSS AI Digest/);
  assert.match((await R.store.getState(t.id)).lastStatus, /^Sent( via compose window)?: 1 stories from 2 articles/);
});

test("DeepSeek effort 'none' disables thinking", async () => {
  const env = makeMessenger();
  const R = load(LIB, env);
  let body;
  mockFetch(env, async (u, init) => {
    body = JSON.parse(init.body);
    return { status: 200, body: dsResponse('{"a":1}') };
  });
  await R.deepseek.generateJson({ apiKey: "k", model: "deepseek-flash", effort: "none", system: "s", user: "u", example: {} });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
});

test("DeepSeek fallbacks: 503 retry, thinking rejected, blank JSON-mode answer retried", async () => {
  const env = makeMessenger();
  const R = load(LIB, env);
  R.util.sleep = async () => {};
  const bodies = [];
  let n = 0;
  mockFetch(env, async (u, init) => {
    bodies.push(JSON.parse(init.body));
    n++;
    if (n === 1) return { status: 503, body: { error: { message: "Server overloaded", type: "server_error" } } };
    if (n === 2) return { status: 400, body: { error: { message: "Unknown parameter: thinking", type: "invalid_request_error" } } };
    if (n === 3) return { status: 200, body: dsResponse("   ") };
    return { status: 200, body: dsResponse('{"ok":true}') };
  });
  const r = await R.deepseek.generateJson({ apiKey: "k", model: "deepseek-flash", effort: "high", maxTokens: 4000, system: "s", user: "u", example: { ok: true } });
  assert.deepEqual(r.data, { ok: true });
  assert.equal(r.usage.input_tokens, 900);
  assert.equal(bodies.length, 4);
  assert.ok(bodies[1].thinking);
  assert.equal(bodies[2].thinking, undefined);
  assert.equal(bodies[3].response_format.type, "json_object");
});

test("DeepSeek errors: 402 balance hint, 401, cut-off, content filter", async () => {
  const env = makeMessenger();
  const R = load(LIB, env);
  mockFetch(env, async () => ({ status: 402, body: { error: { message: "Insufficient Balance", type: "unknown_error" } } }));
  await assert.rejects(R.deepseek.generateJson({ apiKey: "k", model: "m", effort: "low", system: "s", user: "u" }), /402: Insufficient Balance \(your DeepSeek balance is empty/);
  mockFetch(env, async () => ({ status: 401, body: { error: { message: "Authentication Fails" } } }));
  await assert.rejects(R.ai.listModels("deepseek", "bad"), /401: Authentication Fails \(check the API key/);
  mockFetch(env, async () => ({ status: 200, body: dsResponse('{"a":', "length") }));
  await assert.rejects(R.deepseek.generateJson({ apiKey: "k", model: "m", effort: "low", system: "s", user: "u" }), /cut off/);
  mockFetch(env, async () => ({ status: 200, body: dsResponse("", "content_filter") }));
  await assert.rejects(R.deepseek.generateJson({ apiKey: "k", model: "m", effort: "low", system: "s", user: "u" }), /content filter/);
});

test("DeepSeek model list", async () => {
  const env = makeMessenger();
  const R = load(LIB, env);
  mockFetch(env, async (u, init) => {
    assert.equal(u, "https://api.deepseek.com/models");
    assert.equal(init.headers.Authorization, "Bearer k");
    return { status: 200, body: { object: "list", data: [{ id: "deepseek-flash", object: "model", owned_by: "deepseek" }, { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }] } };
  });
  const models = await R.ai.listModels("deepseek", "k");
  assert.deepEqual(models, [{ id: "deepseek-flash", name: "deepseek-flash" }, { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }]);
});

test("missing key gives a clear provider-specific error", async () => {
  const env = makeMessenger({ feedMessages: [{ id: 1, folderId: "account1://Nature", subject: "A", author: "", date: new Date().toISOString(), link: "https://n/a", html: "a" }] });
  const R = load(LIB.concat(["background.js"]), env);
  const t = R.store.newTopic({ folderIds: ["account1://Nature"] });
  await R.store.upsertTopic(t);
  await assert.rejects(R.bg.runTopic(t.id), /Add your DeepSeek API key/);
});
