# opencode-netlify-ai

OpenCode provider plugin for Netlify's AI Gateway. It talks to a relay you deploy from
[netlify-ai-opencode](https://github.com/bridgpal/netlify-ai-opencode); deploy that first.

## Install

In `~/.config/opencode/opencode.json` (or a project `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["opencode-netlify-ai", { "url": "https://YOUR-RELAY.netlify.app" }]]
}
```

Give OpenCode your relay key, either through its auth store:

```
opencode auth login
# choose "Other", provider id: netlify-ai, paste the secret part of the relay key
```

or through the environment:

```
export NETLIFY_AI_RELAY_KEY=...
```

Models appear under the `netlify-ai` provider, for example `netlify-ai/claude-fable-5-1`, and
cover Anthropic, OpenAI and Gemini in one list fetched from the relay's `/models` at startup.

## Options

| Option | Purpose |
| --- | --- |
| `url` | Relay base URL. Can also come from `NETLIFY_AI_RELAY_URL`. |
| `key` | Relay key. Prefer the auth store or `NETLIFY_AI_RELAY_KEY`. |
| `upstreams` | Array limiting which of `anthropic`, `openai`, `gemini` are listed. |

## Notes

- Cost shows as zero in OpenCode because usage is billed in Netlify credits on your team.
- The gateway caps input at 200k tokens, flushes streams in roughly 4 KB blocks, and does not forward beta headers.
- If the relay cannot be reached at startup a small built-in model list is used instead.
