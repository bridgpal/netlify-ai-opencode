# OpenCode plugin (local)

OpenCode v2 provider plugin for Netlify's AI Gateway, loaded from this directory rather than npm.
Setup lives in the main README: clone the repo, point `opencode.json` at this `plugin` directory
with your relay URL, and connect the key with `opencode auth login netlify-ai`.

```json
"plugin": [["/absolute/path/to/netlify-ai-opencode/plugin", { "url": "https://YOUR-SITE.netlify.app" }]]
```

Options: `url`, `key` (prefer the credential store or `NETLIFY_AI_RELAY_KEY`), `upstreams`
(subset of `anthropic`, `openai`, `gemini`, `openrouter`).

Layout: `src/index.ts` is the source, `dist/index.js` the committed build that OpenCode loads
through `index.js`. Rebuild with `npm run build` here, then restart OpenCode's background service.

Notes:
- Cost shows as zero in OpenCode because usage is billed in Netlify credits on your team.
- The gateway caps input at 200k tokens, flushes streams in roughly 4 KB blocks, and does not forward beta headers.
- If the relay cannot be reached at load, or no key is connected yet, a small built-in model list is used. Run `opencode reload` after connecting a key.
- No runtime dependency on `@opencode/plugin`; the module exports the `{ id, setup }` shape OpenCode v2 expects.
