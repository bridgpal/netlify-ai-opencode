import type { Config, Context } from "@netlify/edge-functions";
import { authenticate, deny } from "../lib/auth.ts";
import { credentials, resolve } from "../lib/providers.ts";
import { allowedModel, modelFromRequest } from "../lib/models-policy.ts";
import { tapUsage } from "../lib/usage.ts";
import { dailyTokenBudget, ledgerEnabled, overBudget, readDay, record } from "../lib/ledger.ts";

const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta", "x-stainless-retry-count"];
const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive",
  "set-cookie", "alt-svc", "strict-transport-security", "server", "via", "x-cache",
]);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const jsonError = (status: number, type: string, message: string) =>
  Response.json({ error: { type, message } }, { status, headers: { "cache-control": "no-store" } });

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const target = resolve(url.pathname);
  if (!target) return jsonError(404, "not_found", "Unknown provider prefix.");

  const auth = await authenticate(req);
  if (!auth.ok) return deny(auth);

  if (!["GET", "POST"].includes(req.method)) {
    return jsonError(405, "method_not_allowed", "Only GET and POST are relayed.");
  }

  const creds = credentials(target.provider);
  if (!creds) {
    return jsonError(503, "gateway_unavailable",
      `AI Gateway credentials for ${target.provider.id} are not present. The site needs one production deploy, AI features enabled on the team, and no ${target.provider.keyEnv} of your own set in the environment.`);
  }

  // Read the body once: we need the model id for the allowlist and the ledger.
  let rawBody: string | undefined;
  let parsedBody: unknown;
  if (req.method === "POST") {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return jsonError(413, "payload_too_large", "Request body exceeds 8 MB.");
    rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) return jsonError(413, "payload_too_large", "Request body exceeds 8 MB.");
    if ((req.headers.get("content-type") ?? "").includes("json")) {
      try { parsedBody = JSON.parse(rawBody); } catch { /* upstream will reject it */ }
    }
  }

  const model = modelFromRequest(target.rest, parsedBody);
  if (req.method === "POST" && !allowedModel(model)) {
    return jsonError(403, "model_not_allowed", `Model "${model ?? "unknown"}" is not on this relay's allowlist.`);
  }

  const budget = dailyTokenBudget();
  const useLedger = ledgerEnabled();
  if (useLedger && budget) {
    const day = await readDay(auth.key.name);
    if (overBudget(day, budget)) {
      return jsonError(429, "budget_exhausted",
        `Key "${auth.key.name}" has used ${day.input_tokens + day.output_tokens} of ${budget} tokens today. Resets at 00:00 UTC.`);
    }
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  for (const [k, v] of Object.entries(target.provider.authHeaders(creds.key))) headers.set(k, v);
  // The gateway rejects requests without a JSON content type, even GETs.
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("user-agent", "netlify-ai-opencode-relay");

  const upstream = await fetch(creds.base + target.rest + url.search, {
    method: req.method,
    headers,
    body: rawBody,
  });

  const responseHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) responseHeaders.set(k, v);
  });
  if (!responseHeaders.has("cache-control")) responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-relay-key", auth.key.name);

  let body = upstream.body;
  if (body && useLedger && req.method === "POST" && upstream.ok) {
    const isEventStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    body = tapUsage(body, isEventStream, (usage) => record(auth.key.name, model, usage));
  }

  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
};

export const config: Config = {
  path: ["/anthropic/*", "/openai/*", "/gemini/*", "/openrouter/*"],
};
