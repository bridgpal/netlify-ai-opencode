import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * opencode-netlify-ai
 *
 * Registers a `netlify-ai` provider whose models are served by a netlify-ai-opencode
 * relay (https://github.com/bridgpal/netlify-ai-opencode). Each model carries its
 * own SDK adapter and relay path, so Anthropic, OpenAI and Gemini models all sit
 * under one provider and one relay key.
 *
 * Configuration (opencode.json):
 *   "plugin": [["opencode-netlify-ai", { "url": "https://my-relay.netlify.app" }]]
 *
 * Key: `opencode auth login` -> Other -> provider id `netlify-ai` -> paste the relay
 * key, or set NETLIFY_AI_RELAY_KEY. The URL can also come from NETLIFY_AI_RELAY_URL.
 *
 * Only functions may be exported from this module: OpenCode calls every export.
 */

const PROVIDER_ID = "netlify-ai";
const ENV_URL = "NETLIFY_AI_RELAY_URL";
const ENV_KEY = "NETLIFY_AI_RELAY_KEY";

type Upstream = "anthropic" | "openai" | "gemini" | "openrouter";

const ADAPTERS: Record<Upstream, { npm: string; path: string }> = {
  anthropic: { npm: "@ai-sdk/anthropic", path: "/anthropic/v1" },
  openai: { npm: "@ai-sdk/openai", path: "/openai/v1" },
  gemini: { npm: "@ai-sdk/google", path: "/gemini/v1beta" },
  // OpenRouter-routed ids are accepted on the OpenAI chat-completions route.
  openrouter: { npm: "@ai-sdk/openai-compatible", path: "/openai/v1" },
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
  /** Relay key. Prefer `opencode auth login` or NETLIFY_AI_RELAY_KEY over putting it here. */
  key?: string;
  /** Only list these upstreams. Default: all four (anthropic, openai, gemini, openrouter). */
  upstreams?: Upstream[];
};

/** Used when the relay cannot be reached or no key is known yet, so the provider still appears. */
const FALLBACK_MODELS: RelayModel[] = [
  { id: "claude-fable-5-1", provider: "anthropic", name: "Claude Fable 5.1", context: 200_000, output: 64_000, reasoning: true, toolcall: true, attachment: true },
  { id: "claude-opus-5", provider: "anthropic", name: "Claude Opus 5", context: 200_000, output: 64_000, reasoning: true, toolcall: true, attachment: true },
  { id: "claude-sonnet-5", provider: "anthropic", name: "Claude Sonnet 5", context: 200_000, output: 64_000, reasoning: true, toolcall: true, attachment: true },
  { id: "claude-haiku-4-5", provider: "anthropic", name: "Claude Haiku 4.5", context: 200_000, output: 64_000, reasoning: true, toolcall: true, attachment: true },
  { id: "gpt-5", provider: "openai", name: "gpt-5", context: 200_000, output: 32_768, reasoning: true, toolcall: true, attachment: true },
  { id: "gpt-5-mini", provider: "openai", name: "gpt-5-mini", context: 200_000, output: 32_768, reasoning: true, toolcall: true, attachment: true },
  { id: "gemini-2.5-pro", provider: "gemini", name: "Gemini 2.5 Pro", context: 200_000, output: 65_536, reasoning: true, toolcall: true, attachment: true },
  { id: "deepseek/deepseek-v4-flash", provider: "openrouter", name: "deepseek/deepseek-v4-flash", context: 200_000, output: 16_384, reasoning: true, toolcall: true, attachment: false },
];

const trimSlash = (u: string) => u.trim().replace(/\/+$/, "");

/** Best effort: the key saved by `opencode auth login` lives in OpenCode's auth.json. */
async function storedKey(): Promise<string | undefined> {
  const dataDir = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "opencode") : join(homedir(), ".local", "share", "opencode");
  try {
    const json = JSON.parse(await readFile(join(dataDir, "auth.json"), "utf8")) as Record<string, { type?: string; key?: string }>;
    const entry = json[PROVIDER_ID];
    return entry?.type === "api" ? entry.key : undefined;
  } catch {
    return undefined;
  }
}

async function fetchModels(url: string, key: string): Promise<RelayModel[]> {
  const res = await fetch(`${url}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`relay /models returned ${res.status}`);
  const json = (await res.json()) as { data?: RelayModel[] };
  if (!json.data?.length) throw new Error("relay /models returned no models");
  return json.data;
}

/** Shape expected under `provider.<id>.models.<modelID>` in opencode.json. */
function toConfigModel(url: string, m: RelayModel) {
  const adapter = ADAPTERS[m.provider];
  return {
    name: `${m.name} (${m.provider})`,
    provider: { npm: adapter.npm, api: `${url}${adapter.path}` },
    limit: { context: m.context, output: m.output },
    reasoning: m.reasoning,
    attachment: m.attachment,
    tool_call: m.toolcall,
    temperature: !(m.provider === "openai" && m.reasoning),
    modalities: {
      input: m.attachment ? (m.provider === "openai" ? ["text", "image"] : ["text", "image", "pdf"]) : ["text"],
      output: ["text"],
    },
    // Usage is billed in Netlify credits on your team, so per-token cost is unknown here.
    cost: { input: 0, output: 0 },
    status: "active",
  };
}

export const NetlifyAIGatewayPlugin: Plugin = async (_input, options): Promise<Hooks> => {
  const opts = (options ?? {}) as PluginOptions;
  const url = opts.url ? trimSlash(opts.url) : process.env[ENV_URL] ? trimSlash(process.env[ENV_URL]!) : undefined;
  const explicitKey = opts.key || process.env[ENV_KEY];
  const upstreams = new Set<Upstream>(opts.upstreams ?? ["anthropic", "openai", "gemini", "openrouter"]);

  return {
    auth: {
      provider: PROVIDER_ID,
      methods: [{ type: "api", label: "Relay key" }],
      loader: async () => ({}),
    },

    config: async (config) => {
      if (!url) {
        console.warn(`[opencode-netlify-ai] no relay URL: pass { "url": "https://..." } as the plugin option or set ${ENV_URL}`);
        return;
      }
      const cfg = config as { provider?: Record<string, Record<string, unknown>> };
      cfg.provider ??= {};
      const existing = cfg.provider[PROVIDER_ID] ?? {};

      const key = explicitKey ?? (await storedKey());
      let list = FALLBACK_MODELS;
      if (key) {
        try {
          list = await fetchModels(url, key);
        } catch (err) {
          console.warn(`[opencode-netlify-ai] using fallback model list: ${err instanceof Error ? err.message : err}`);
        }
      }
      const models = Object.fromEntries(list.filter((m) => upstreams.has(m.provider)).map((m) => [m.id, toConfigModel(url, m)]));

      cfg.provider[PROVIDER_ID] = {
        npm: ADAPTERS.anthropic.npm,
        name: "Netlify AI Gateway",
        ...existing,
        options: { ...(explicitKey ? { apiKey: explicitKey } : {}), ...((existing.options as object | undefined) ?? {}) },
        // User-declared models win over the relay list.
        models: { ...models, ...((existing.models as object | undefined) ?? {}) },
      };
    },
  };
};

export default NetlifyAIGatewayPlugin;
