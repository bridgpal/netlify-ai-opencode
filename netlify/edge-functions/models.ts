import type { Config } from "@netlify/edge-functions";
import { authenticate, deny } from "../lib/auth.ts";
import { credentials, PROVIDERS } from "../lib/providers.ts";
import { allowedModel } from "../lib/models-policy.ts";
import { env } from "../lib/env.ts";

export type RelayModel = {
  id: string;
  provider: "anthropic" | "openai" | "gemini";
  name: string;
  context: number;
  output: number;
  reasoning: boolean;
  toolcall: boolean;
  attachment: boolean;
};

const GATEWAY_CONTEXT_CAP = 200_000;

/**
 * The gateway has no list endpoint for Anthropic models, so these come from the
 * published model table. Override with RELAY_ANTHROPIC_MODELS (comma-separated ids).
 * Docs: https://docs.netlify.com/build/ai-gateway/overview/#model-availability
 */
const ANTHROPIC_DEFAULTS = [
  "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-sonnet-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6",
  "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5",
];

const prettyClaude = (id: string) =>
  id.replace(/^claude-/, "Claude ").replace(/-(\d)-(\d)$/, " $1.$2").replace(/-(\d)$/, " $1")
    .replace(/(fable|opus|sonnet|haiku)/, (m) => m[0].toUpperCase() + m.slice(1));

function anthropicModels(): RelayModel[] {
  const ids = (env("RELAY_ANTHROPIC_MODELS") ?? ANTHROPIC_DEFAULTS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  return ids.map((id) => ({
    id, provider: "anthropic", name: prettyClaude(id),
    context: GATEWAY_CONTEXT_CAP, output: 64_000, reasoning: true, toolcall: true, attachment: true,
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

let cache: { at: number; models: RelayModel[] } | undefined;
const TTL_MS = 5 * 60 * 1000;

export default async (req: Request) => {
  const auth = await authenticate(req);
  if (!auth.ok) return deny(auth);

  if (!cache || Date.now() - cache.at > TTL_MS) {
    const [openai, gemini] = await Promise.all([openaiModels().catch(() => []), geminiModels().catch(() => [])]);
    cache = { at: Date.now(), models: [...anthropicModels(), ...openai, ...gemini] };
  }
  const data = cache.models.filter((m) => allowedModel(m.id));
  return Response.json(
    { object: "list", data, note: "Model availability is controlled by Netlify's AI Gateway. Anthropic ids come from the published table; OpenAI and Gemini ids are fetched live." },
    { headers: { "cache-control": "no-store" } },
  );
};

export const config: Config = { path: "/models" };
