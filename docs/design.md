# Design notes

What the relay does, why it exists, and the gateway behavior we verified while building it.
Verified on 2026-09-22 against a fresh site on an Enterprise team; re-check the dated facts if
something stops working.

## Why a relay

Netlify's AI Gateway is only reachable from Netlify compute. When a Function or Edge Function
starts, the platform injects a base URL and key per provider (`ANTHROPIC_BASE_URL`,
`ANTHROPIC_API_KEY`, and the OpenAI, Gemini and OpenRouter equivalents). Nothing outside
Netlify can obtain those, so a tool such as OpenCode running on a laptop needs something on
Netlify to call on its behalf. That something is this relay.

## Verified gateway facts

| Fact | Observed | Consequence for the relay |
| --- | --- | --- |
| Base URL | `https://<your-site>.netlify.app/.netlify/ai` for every provider | One upstream host; the relay only strips its own prefix and appends the rest of the path |
| Key | A JWT issued per request, `exp` 60 seconds after `iat`, claims include `site_id`, `account_id`, `request_id`, `source_ip` | Read the env var on every request; never cache it; you cannot hand it to a client |
| Same key for all providers | `ANTHROPIC_API_KEY === OPENAI_API_KEY === NETLIFY_AI_GATEWAY_KEY` | Routing is by path shape and auth header, not by key |
| Edge Functions get the vars | Yes, same as Functions | The relay is an Edge Function: no CPU-heavy work, streams for as long as the model talks |
| Routes | `/v1/messages` Anthropic, `/v1/chat/completions` and `/v1/responses` OpenAI (and OpenRouter ids), `/v1beta/models/...` Gemini, `/chat/completions` OpenRouter SDK | Path-transparent proxying works with the stock SDKs |
| Content type | Any request without `content-type: application/json` gets a 400, including GETs | Relay sets it when the client did not |
| Model lists | `GET /v1/models` returns the OpenAI catalog only; `GET /v1beta/models` returns Gemini; no list for Anthropic or OpenRouter-routed models | `/models` fetches those two live and parses Anthropic and OpenRouter ids out of the published docs table (`overview.md`), cached 1 h, 1 min on failure |
| Streaming | SSE arrives in roughly 4 KB blocks, not per token (9 KB in 3 chunks, 23 KB in 6, measured from inside the edge function) | Output appears in bursts in OpenCode; the relay does not buffer, the gateway does |
| Time to first byte | 1.3 to 5 s for short prompts on Haiku | Expected; nothing to tune in the relay |
| Headers | Request headers are not forwarded to the provider | `anthropic-beta` features silently do not apply |
| Input cap | 200k tokens | Every model is advertised to OpenCode with `context: 200000` |
| Prompt caching | Anthropic default 5-minute ephemeral only | Fine for OpenCode |
| Activation | Requires one production deploy and AI features enabled on the team | Deploy to Netlify button satisfies the first; Enterprise teams need their account manager for the second |

## Request path

```
OpenCode  --(Authorization / x-api-key / x-goog-api-key: <relay key>)-->  https://relay/anthropic/v1/messages
  relay.ts
    1. resolve provider from the first path segment
    2. authenticate: sha256(presented) compared in constant time against every RELAY_KEYS entry
    3. GET or POST only; body capped at 8 MB
    4. read the model id (JSON body, or the Gemini path) and check RELAY_MODELS_ALLOW
    5. if RELAY_DAILY_TOKEN_BUDGET is set, read today's ledger for the key and refuse with 429 when exhausted
    6. build upstream headers: content-type, accept, anthropic-version, anthropic-beta, plus the gateway key
       in the header that provider expects; the client's own auth headers are dropped
    7. fetch `${<PROVIDER>_BASE_URL}${rest}${search}` and pipe the body straight back
    8. a TransformStream watches the bytes for usage fields and, after the last byte, adds a row to the ledger
```

## Ledger

Netlify Blobs store `netlify-ai-relay-ledger`, one JSON document per key per UTC day:
`requests`, `input_tokens`, `output_tokens`, `models` (count per model id). Writes happen after the
response finished streaming, so they never add latency. Reads use strong consistency. Concurrent
requests can race on the read-modify-write, so treat the numbers as approximate. Netlify's own
usage page remains the billing source of truth.

## Security model

- The gateway key never leaves Netlify. Clients only ever hold a relay key you minted.
- Relay keys are compared by SHA-256 digest in constant time, and every configured key is checked so
  timing does not reveal which one matched.
- Missing `RELAY_KEYS` fails closed with a 503 that says what to set.
- Optional model allowlist (`RELAY_MODELS_ALLOW`) and per-key daily token budget
  (`RELAY_DAILY_TOKEN_BUDGET`) bound the blast radius of a leaked key. Revoke a key by removing it
  from `RELAY_KEYS` and redeploying.
- Netlify rate limiting rules on the relay paths are recommended where the plan includes them.
- The relay adds `X-Robots-Tag: noindex` and a no-referrer policy; the landing page carries no secrets.

## OpenCode integration (v2)

OpenCode 2.x runs a shared background service (`opencode serve --service`) that loads plugins; the
CLI and TUI are clients of it. Run `opencode service restart` after changing plugin code; `opencode reload`
also re-runs plugin loading.

The plugin is a module with a default export `{ id, setup }` (the v2 promise API; `Plugin.define`
from `@opencode/plugin` is an identity function, so the plugin ships without that dependency). It is
loaded from the cloned repo's `plugin` directory, never from npm; `dist/` is committed so a clone needs no build. In
`setup` it:

1. registers an integration `netlify-ai` with a `key` method (`opencode auth login netlify-ai`) and an
   `env` method (`NETLIFY_AI_RELAY_KEY`), via `ctx.integration.transform`;
2. resolves the connected key (`ctx.integration.connection.active` and `resolve`) or takes it from the
   plugin option or env, and fetches the relay's `/models`;
3. adds a provider `netlify-ai` with `activation: "auto"` and `integrationID: "netlify-ai"`, via
   `ctx.provider.transform(editor => editor.add({ info, models }))`. OpenCode injects the connected
   key as `apiKey` at request time, so the plugin never handles credentials for requests.

Each model carries `package` and `settings.baseURL`. Packages must use the `aisdk:` prefix
(`aisdk:@ai-sdk/anthropic`, `aisdk:@ai-sdk/openai`, `aisdk:@ai-sdk/google`,
`aisdk:@ai-sdk/openai-compatible`); a bare name is treated as a native `@opencode/ai` module and
fails with "does not export model(modelID, settings)".

Config facts learned the hard way: the plugin entry must be the tuple form `["pkg", { options }]`
(the object form `{ "package", "options" }` is what the normalized config looks like internally and
is rejected in user config); a local plugin path must be a directory containing `index.js` or
`server.js`; `file://` specs are treated as npm targets.

Plugins do not run for `opencode models` until the service has finished loading, so an immediate
count of zero right after a restart is a race, not a failure.

OpenCode 1.x used a different plugin API (named function exports with `config`/`auth` hooks and a
`provider.models` hook that only fired for models.dev providers). That version of the plugin was
replaced; 1.x users can use `scripts/opencode-provider.mjs` to generate a provider block instead.
