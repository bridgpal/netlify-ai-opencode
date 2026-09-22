import type { Config } from "@netlify/edge-functions";
import { authenticate, deny } from "../lib/auth.ts";
import { credentials, PROVIDERS } from "../lib/providers.ts";
import { allowedModel } from "../lib/models-policy.ts";
import { env, flag } from "../lib/env.ts";

export type RelayModel = {
  id: string;
  provider: "anthropic" | "openai" | "gemini" | "openrouter";
  name: string;
  context: number;
  output: number;
  reasoning: boolean;
  toolcall: boolean;
  attachment: boolean;
};

const GATEWAY_CONTEXT_CAP = 200_000;

/**
 * The gateway has no list endpoint for Anthropic or OpenRouter-routed models, so those ids
 * come from Netlify's published model table, fetched live and cached for an hour.
 * Override Anthropic with RELAY_ANTHROPIC_MODELS (comma-separated ids). Set RELAY_OPENROUTER=false
 * to leave the OpenRouter catalog out of /models (they stay callable).
 * Docs: https://docs.netlify.com/build/ai-gateway/overview/#model-availability
 */
const MODEL_TABLE_URL = "https://docs.netlify.com/build/ai-gateway/overview.md";

const ANTHROPIC_FALLBACK = [
  "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6",
  "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5",
];

const prettyClaude = (id: string) =>
  id.replace(/^claude-/, "Claude ").replace(/-(\d)-(\d)(-\d{8})?$/, " $1.$2$3").replace(/-(\d)$/, " $1")
    .replace(/(fable|opus|sonnet|haiku)/, (m) => m[0].toUpperCase() + m.slice(1));

/** Parse `| Anthropic | id |` style rows out of the docs page. */
async function publishedTable(): Promise<{ anthropic: string[]; openrouter: string[] }> {
  const out = { anthropic: [] as string[], openrouter: [] as string[] };
  try {
    const res = await fetch(MODEL_TABLE_URL, { headers: { accept: "text/markdown, text/plain" } });
    if (!res.ok) return out;
    const text = await res.text();
    for (const m of text.matchAll(/^\|\s*(Anthropic|Openrouter)\s*\|\s*([^|\s]+)\s*\|/gim)) {
      (m[1].toLowerCase() === "anthropic" ? out.anthropic : out.openrouter).push(m[2]);
    }
  } catch {
    /* docs unreachable: callers fall back */
  }
  return out;
}

function anthropicModels(published: string[]): RelayModel[] {
  const override = env("RELAY_ANTHROPIC_MODELS");
  const ids = override
    ? override.split(",").map((s) => s.trim()).filter(Boolean)
    : (published.length ? published : ANTHROPIC_FALLBACK).filter((id) => !/-\d{8}$/.test(id)); // hide dated aliases
  return ids.map((id) => ({
    id, provider: "anthropic", name: prettyClaude(id),
    context: GATEWAY_CONTEXT_CAP, output: 64_000, reasoning: true, toolcall: true, attachment: true,
  }));
}

function openrouterModels(published: string[]): RelayModel[] {
  if (!flag("RELAY_OPENROUTER", true)) return [];
  return published
    .filter((id) => !/guard|safety|schematron|hy-mt2|relace|morph\/|inkling|-mt-|embedding|whisper/i.test(id))
    .map((id) => ({
      id, provider: "openrouter" as const, name: id,
      context: GATEWAY_CONTEXT_CAP, output: 16_384,
      reasoning: /r1|thinking|reason|grok|glm-5|deepseek-v4|kimi-k2\.5|kimi-k2\.6|kimi-k3|qwen3\.[5-8]|minimax-m[2-3]/i.test(id),
      toolcall: true, attachment: false,
    }));
}

const OPENAI_SKIP = /image|tts|whisper|embedding|realtime|audio|dall-e|moderation|transcribe|search|computer-use/i;

async function openaiModels(): Promise<RelayModel[]> {
  const creds = credentials(PROVIDERS.openai);
  if (!creds) return [];
  const res = await fetch(`${creds.base}/v1/models`, { headers: { authorization: `Bearer ${creds.key}`, "content-type": "application/json" } });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? [])
    .map((m) => m.id)
    .filter((id) => !OPENAI_SKIP.test(id))
    .map((id) => ({
      id, provider: "openai" as const, name: id,
      context: GATEWAY_CONTEXT_CAP, output: 32_768,
      reasoning: /^(o\d|gpt-5|gpt-6|chat-latest)/.test(id), toolcall: true, attachment: true,
    }));
}

async function geminiModels(): Promise<RelayModel[]> {
  const creds = credentials(PROVIDERS.gemini);
  if (!creds) return [];
  const out: RelayModel[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const u = new URL(`${creds.base}/v1beta/models`);
    u.searchParams.set("pageSize", "200");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await fetch(u, { headers: { "x-goog-api-key": creds.key, "content-type": "application/json" } });
    if (!res.ok) break;
    const json = (await res.json()) as {
      nextPageToken?: string;
      models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[]; thinking?: boolean }>;
    };
    for (const m of json.models ?? []) {
      if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
      const id = m.name.replace(/^models\//, "");
      if (/image|tts|audio|embedding|veo|imagen|live|aqa/i.test(id)) continue;
      out.push({
        id, provider: "gemini", name: m.displayName ?? id,
        context: Math.min(m.inputTokenLimit ?? GATEWAY_CONTEXT_CAP, GATEWAY_CONTEXT_CAP),
        output: m.outputTokenLimit ?? 8_192, reasoning: !!m.thinking, toolcall: true, attachment: true,
      });
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

let cache: { at: number; ttl: number; models: RelayModel[] } | undefined;
const TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000; // when the published table could not be fetched, try again soon

export default async (req: Request) => {
  const auth = await authenticate(req);
  if (!auth.ok) return deny(auth);

  if (!cache || Date.now() - cache.at > cache.ttl) {
    const [published, openai, gemini] = await Promise.all([publishedTable(), openaiModels().catch(() => []), geminiModels().catch(() => [])]);
    const complete = published.anthropic.length > 0 && openai.length > 0 && gemini.length > 0;
    cache = {
      at: Date.now(),
      ttl: complete ? TTL_MS : RETRY_MS,
      models: [...anthropicModels(published.anthropic), ...openai, ...gemini, ...openrouterModels(published.openrouter)],
    };
  }
  const data = cache.models.filter((m) => allowedModel(m.id));
  return Response.json(
    { object: "list", data, note: "Model availability is controlled by Netlify's AI Gateway. OpenAI and Gemini ids are fetched live from the gateway; Anthropic and OpenRouter ids come from Netlify's published model table." },
    { headers: { "cache-control": "no-store" } },
  );
};

export const config: Config = { path: "/models" };
