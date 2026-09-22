import { env } from "./env.ts";

/** RELAY_MODELS_ALLOW: comma-separated globs (`claude-*,gpt-5*`). Empty means everything is allowed. */
export function allowedModel(model: string | undefined): boolean {
  const raw = env("RELAY_MODELS_ALLOW");
  if (!raw) return true;
  if (!model) return false;
  return raw
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .some((glob) => new RegExp("^" + glob.split("*").map(escape).join(".*") + "$", "i").test(model));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pull the model id out of a request: JSON body for Anthropic/OpenAI/OpenRouter, the path for Gemini. */
export function modelFromRequest(path: string, body: unknown): string | undefined {
  const fromPath = path.match(/\/models\/([^/:?]+)/)?.[1];
  if (fromPath) return fromPath;
  if (body && typeof body === "object" && typeof (body as { model?: unknown }).model === "string") {
    return (body as { model: string }).model;
  }
  return undefined;
}
