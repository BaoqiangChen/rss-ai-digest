"use strict";
// Picks the AI provider chosen in Settings (DeepSeek by default, or Claude).
var RCD = (globalThis.RCD = globalThis.RCD || {});

RCD.ai = (() => {
  function client(id) {
    return id === "claude" ? RCD.claude : RCD.deepseek;
  }

  async function listModels(provider, apiKey) {
    return client(provider).listModels(apiKey);
  }

  async function generateJson(settings, { system, user, schema, example }) {
    const p = RCD.store.activeProvider(settings);
    if (!p.apiKey) throw new Error(`Add your ${p.label} API key on the settings page first.`);
    const r = await client(p.id).generateJson({
      apiKey: p.apiKey,
      model: p.model,
      effort: p.effort,
      maxTokens: Number(settings.maxTokens) || 16000,
      system,
      user,
      schema,
      example,
    });
    return { ...r, label: `${p.label} ${r.model}` };
  }

  return { listModels, generateJson };
})();
