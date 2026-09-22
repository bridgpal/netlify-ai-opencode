#!/usr/bin/env node
// Prints an OpenCode `provider` block for a netlify-ai-opencode relay, built from its /models.
// Usage: node scripts/opencode-provider.mjs https://my-relay.netlify.app <relay-key> [--upstreams anthropic,openai,gemini,openrouter] [--key-env NETLIFY_AI_RELAY_KEY]
// Paste the output into opencode.json (merge into your existing "provider" object if you have one).

const [url, key, ...rest] = process.argv.slice(2);
if (!url || !key) {
  console.error("usage: opencode-provider.mjs <relay-url> <relay-key> [--upstreams a,b] [--key-env VAR]");
  process.exit(1);
}
const arg = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const upstreams = new Set((arg("--upstreams") ?? "anthropic,openai,gemini,openrouter").split(","));
const keyEnv = arg("--key-env");

const ADAPTERS = {
  anthropic: { npm: "@ai-sdk/anthropic", path: "/anthropic/v1" },
  openai: { npm: "@ai-sdk/openai", path: "/openai/v1" },
  gemini: { npm: "@ai-sdk/google", path: "/gemini/v1beta" },
  openrouter: { npm: "@ai-sdk/openai-compatible", path: "/openai/v1" },
};

const base = url.replace(/\/+$/, "");
const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
if (!res.ok) { console.error(`relay /models returned ${res.status}`); process.exit(1); }
const { data } = await res.json();

const models = {};
for (const m of data) {
  if (!upstreams.has(m.provider)) continue;
  const a = ADAPTERS[m.provider];
  models[m.id] = {
    name: `${m.name} (${m.provider})`,
    provider: { npm: a.npm, api: `${base}${a.path}` },
    limit: { context: m.context, output: m.output },
    reasoning: m.reasoning,
    tool_call: m.toolcall,
    attachment: m.attachment,
    temperature: !(m.provider === "openai" && m.reasoning),
  };
}

const block = {
  provider: {
    "netlify-ai": {
      npm: ADAPTERS.anthropic.npm,
      name: "Netlify AI Gateway",
      options: { apiKey: keyEnv ? `{env:${keyEnv}}` : key },
      models,
    },
  },
};
process.stdout.write(JSON.stringify(block, null, 2) + "\n");
console.error(`${Object.keys(models).length} models from ${base}`);
