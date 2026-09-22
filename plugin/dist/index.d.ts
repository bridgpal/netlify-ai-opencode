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
import type { Plugin } from "@opencode/plugin";
declare const plugin: Plugin.Plugin;
export default plugin;
