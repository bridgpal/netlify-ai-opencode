/**
 * opencode-netlify-ai (OpenCode v2 plugin)
 *
 * Adds a `netlify-ai` provider backed by a netlify-ai-opencode relay
 * (https://github.com/bridgpal/netlify-ai-opencode). Anthropic, OpenAI, Gemini and
 * OpenRouter-routed models all appear under the one provider; each model carries the
 * SDK package and relay path it needs, and one relay key covers everything.
 *
 * opencode.json (path to this directory in your clone; the plugin is not on npm):
 *   "plugin": [["/absolute/path/to/netlify-ai-opencode/plugin", { "url": "https://my-relay.netlify.app" }]]
 *
 * Key: `opencode auth login` -> Netlify AI Gateway -> paste the relay key, or set
 * NETLIFY_AI_RELAY_KEY. The URL may also come from NETLIFY_AI_RELAY_URL.
 *
 * This module has no runtime dependency on @opencode/plugin (types only): OpenCode
 * needs a default export shaped { id, setup }, which is what Plugin.define returns.
 */

import type { Model, Plugin, Provider } from "@opencode/plugin";

const PROVIDER_ID = "netlify-ai";
const ENV_URL = "NETLIFY_AI_RELAY_URL";
const ENV_KEY = "NETLIFY_AI_RELAY_KEY";
const GATEWAY_CONTEXT_CAP = 200_000;

type Upstream = "anthropic" | "openai" | "gemini" | "openrouter";

// OpenCode v2 loads AI SDK provider packages through the "aisdk:" prefix; bare names are treated as native modules.
const ADAPTERS: Record<Upstream, { package: string; path: string }> = {
  anthropic: { package: "aisdk:@ai-sdk/anthropic", path: "/anthropic/v1" },
  openai: { package: "aisdk:@ai-sdk/openai", path: "/openai/v1" },
  gemini: { package: "aisdk:@ai-sdk/google", path: "/gemini/v1beta" },
  // OpenRouter-routed ids are accepted on the OpenAI chat-completions route.
  openrouter: { package: "aisdk:@ai-sdk/openai-compatible", path: "/openai/v1" },
};

type RelayModel = {
  id: string;
  provider: Upstream;
  name: string;
  context: number;
  output: number;
  reasoning: boolean;
  toolcall: boolean;
  attachment: boolean;
};

type PluginOptions = {
  /** Relay base URL, e.g. https://my-relay.netlify.app */
  url?: string;
  /** Relay key. Prefer `opencode auth login` or NETLIFY_AI_RELAY_KEY. */
  key?: string;
  /** Only list these upstreams. Default: all four. */
  upstreams?: Upstream[];
};

/** Shown when the relay cannot be reached or no key is known yet. */
const FALLBACK_MODELS: RelayModel[] = [
  { id: "claude-fable-5-1", provider: "anthropic", name: "Claude Fable 5.1", context: GATEWAY_CONTEXT_CAP, output: 64_000, reasoning: true, toolcall: true, attachment: true },
  { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5", context: GATEWAY_CONTEXT_CAP, output: 64_000, reasoning: true, toolcall: true, attachment: true },
  { id: "claude-sonnet-5", provider: "anthropic", name: "Claude Sonnet 5", context: GATEWAY_CONTEXT_CAP, output: 64_000, reasoning: true, toolcall: true, attachment: true },
  { id: "claude-haiku-4-5", provider: "anthropic", name: "Claude Haiku 4.5", context: GATEWAY_CONTEXT_CAP, output: 64_000, reasoning: true, toolcall: true, attachment: true },
  { id: "gpt-5", provider: "openai", name: "gpt-5", context: GATEWAY_CONTEXT_CAP, output: 32_768, reasoning: true, toolcall: true, attachment: true },
  { id: "gpt-5-mini", provider: "openai", name: "gpt-5-mini", context: GATEWAY_CONTEXT_CAP, output: 32_768, reasoning: true, toolcall: true, attachment: true },
  { id: "gemini-2.5-pro", provider: "gemini", name: "Gemini 2.5 Pro", context: GATEWAY_CONTEXT_CAP, output: 65_536, reasoning: true, toolcall: true, attachment: true },
  { id: "deepseek/deepseek-v4-flash", provider: "openrouter", name: "deepseek/deepseek-v4-flash", context: GATEWAY_CONTEXT_CAP, output: 16_384, reasoning: true, toolcall: true, attachment: false },
];

// Types come from the official SDK as a type-only dev dependency; nothing from it is imported at runtime.
type Context = Plugin.Context;
type ProviderInfo = Provider.Info;
type ModelInfo = Model.Info;

const trimSlash = (u: string) => u.trim().replace(/\/+$/, "");

async function fetchModels(url: string, key: string): Promise<RelayModel[]> {
  const res = await fetch(`${url}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`relay /models returned ${res.status}`);
  const json = (await res.json()) as { data?: RelayModel[] };
  if (!json.data?.length) throw new Error("relay /models returned no models");
  return json.data;
}

function toModel(url: string, m: RelayModel): ModelInfo {
  const adapter = ADAPTERS[m.provider];
  return {
    id: m.id as Model.ID,
    modelID: m.id as Model.ID,
    providerID: PROVIDER_ID as Provider.ID,
    name: `${m.name} (${m.provider})`,
    package: adapter.package,
    settings: { baseURL: `${url}${adapter.path}` },
    capabilities: {
      tools: m.toolcall,
      input: m.attachment ? (m.provider === "openai" ? ["text", "image"] : ["text", "image", "pdf"]) : ["text"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    // Usage is billed in Netlify credits on your team, so per-token cost is unknown here.
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: Math.min(m.context, GATEWAY_CONTEXT_CAP), output: m.output },
  };
}

async function storedKey(ctx: Context): Promise<string | undefined> {
  try {
    const connection = await ctx.integration.connection.active(PROVIDER_ID);
    if (!connection) return undefined;
    const credential = await ctx.integration.connection.resolve(connection);
    return credential?.type === "key" ? credential.key : undefined;
  } catch {
    return undefined;
  }
}

const plugin: Plugin.Plugin = {
  id: "opencode-netlify-ai",
  setup: async (ctx: Context) => {
    const opts = (ctx.options ?? {}) as PluginOptions;
    const url = opts.url ? trimSlash(opts.url) : process.env[ENV_URL] ? trimSlash(process.env[ENV_URL]!) : undefined;
    const upstreams = new Set<Upstream>(opts.upstreams ?? ["anthropic", "openai", "gemini", "openrouter"]);

    await ctx.integration.transform((integrations) => {
      integrations.update(PROVIDER_ID, (integration) => {
        integration.name = "Netlify AI Gateway";
      });
      integrations.method.update({ integrationID: PROVIDER_ID, method: { type: "key", label: "Relay key" } });
      integrations.method.update({ integrationID: PROVIDER_ID, method: { type: "env", names: [ENV_KEY] } });
    });

    if (!url) {
      console.warn(`[opencode-netlify-ai] no relay URL: set { "url": "https://..." } in the plugin options or ${ENV_URL}`);
      return;
    }

    const key = opts.key || process.env[ENV_KEY] || (await storedKey(ctx));
    let list = FALLBACK_MODELS;
    if (key) {
      try {
        list = await fetchModels(url, key);
      } catch (err) {
        console.warn(`[opencode-netlify-ai] using fallback model list: ${err instanceof Error ? err.message : err}`);
      }
    }
    const models = list.filter((m) => upstreams.has(m.provider)).map((m) => toModel(url, m));

    await ctx.provider.transform((providers) => {
      const info: ProviderInfo = {
        id: PROVIDER_ID as Provider.ID,
        name: "Netlify AI Gateway",
        package: ADAPTERS.anthropic.package,
        // With a key in the options the provider is always on; otherwise it activates
        // once a relay key is connected (auth login) or NETLIFY_AI_RELAY_KEY is set.
        ...(opts.key
          ? { activation: "enabled" as const, settings: { apiKey: opts.key } }
          : { activation: "auto" as const, integrationID: PROVIDER_ID as ProviderInfo["integrationID"] }),
      };
      providers.add({ info, models });
    });
  },
};

export default plugin;
