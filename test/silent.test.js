const test = require("node:test");
const assert = require("node:assert/strict");
const { makeMessenger, load, LIB } = require("./harness");

const msg = () => [{ id: 1, folderId: "account1://Nature", subject: "A paper", author: "", date: new Date(Date.now() - 1000).toISOString(), link: "https://n/a", html: "<p>a</p>" }];

function mockAI() {
  globalThis.fetch = async () => ({
    ok: true, status: 200, url: "", headers: { get: () => null },
    text: async () => JSON.stringify({ model: "deepseek-flash", usage: {}, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ takeaways: ["t"], sections: [{ title: "S", entries: [{ id: 1, related_ids: [], relevance: 5, headline: "H", summary: "S", why_it_matters: "W" }] }], note: "" }) } }] }),
  });
}

async function setup(opts, topicOver = {}, settingsOver = {}) {
  const env = makeMessenger({ feedMessages: msg(), ...opts });
  const R = load(LIB.concat(["background.js"]), env);
  mockAI();
  await R.store.saveProvider("deepseek", { apiKey: "k" });
  if (Object.keys(settingsOver).length) await R.store.saveSettings(settingsOver);
  const t = R.store.newTopic({ folderIds: ["account1://Nature"], ...topicOver });
  await R.store.upsertTopic(t);
  return { env, R, t };
}

test("silent send: no compose window when TB 153+ and permission granted", async () => {
  const { env, R, t } = await setup({ silentApi: true, sendPermission: true });
  const r = await R.bg.runTopic(t.id);
  assert.equal(r.sent, true);
  assert.equal(env.calls.beginNew.length, 0, "no compose window");
  assert.equal(env.calls.silentSend.length, 1);
  const { details, o } = env.calls.silentSend[0];
  assert.equal(details.identityId, "id1");
  assert.deepEqual(details.to, ["chen@example.org"]);
  assert.equal(details.deliveryFormat, "both");
  assert.match(details.body, /^<!DOCTYPE html>/);
  assert.match(details.body, /H<\/a>/);
  assert.equal(o.mode, "default");
  assert.match((await R.store.getState(t.id)).lastStatus, /^Sent: 1 stories/);
});

test("silent send with plain text", async () => {
  const { env, R, t } = await setup({ silentApi: true, sendPermission: true }, { email: { plainText: true } });
  await R.bg.runTopic(t.id);
  const { details } = env.calls.silentSend[0];
  assert.equal(details.isPlainText, true);
  assert.match(details.plainTextBody, /» H/);
  assert.equal(details.body, undefined);
});

test("permission not granted yet: falls back to a minimised compose window", async () => {
  const { env, R, t } = await setup({ silentApi: true, sendPermission: false });
  await R.bg.runTopic(t.id);
  assert.equal(env.calls.silentSend.length, 0);
  assert.equal(env.calls.beginNew.length, 1);
  assert.deepEqual(env.calls.windowsUpdate[0], { id: 7, o: { state: "minimized" } });
  assert.equal(env.calls.sendMessage.length, 1);
  assert.match((await R.store.getState(t.id)).lastStatus, /^Sent via compose window/);
});

test("older Thunderbird (no API, unknown permission): falls back without crashing", async () => {
  const { env, R, t } = await setup({ silentApi: false, tbVersion: "140.5.0" });
  await R.bg.runTopic(t.id);
  assert.equal(env.calls.beginNew.length, 1);
  assert.equal(env.calls.sendMessage.length, 1);
  const st = await R.mailer.silentStatus();
  assert.equal(st.available, false);
  assert.match(st.reason, /Thunderbird 153 or newer \(you have 140\.5\.0\)/);
});

test("review and preview always open the compose window, never send", async () => {
  const { env, R, t } = await setup({ silentApi: true, sendPermission: true }, { email: { review: true } });
  await R.bg.runTopic(t.id);
  await R.bg.runTopic(t.id, { preview: true });
  assert.equal(env.calls.silentSend.length, 0);
  assert.equal(env.calls.beginNew.length >= 1, true);
  assert.equal(env.calls.sendMessage.length, 0);
  assert.equal(env.calls.windowsUpdate.length, 0, "review window is not minimised");
});

test("silent sending switched off in Settings uses the compose window", async () => {
  const { env, R, t } = await setup({ silentApi: true, sendPermission: true }, {}, { silentSend: false });
  await R.bg.runTopic(t.id);
  assert.equal(env.calls.silentSend.length, 0);
  assert.equal(env.calls.sendMessage.length, 1);
  assert.match((await R.store.getState(t.id)).lastStatus, /^Sent: /);
});

test("silent send server error is reported, not retried through a window", async () => {
  const { env, R, t } = await setup({ silentApi: true, sendPermission: true, sendFails: true });
  await assert.rejects(R.bg.runTopic(t.id), /SMTP failed/);
  assert.equal(env.calls.beginNew.length, 0);
  assert.equal((await R.store.getState(t.id)).lastStatus, "Failed");
  assert.equal((await R.store.getSeen(t.id)).length, 0);
});
