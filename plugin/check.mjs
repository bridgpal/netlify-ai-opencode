// Spec check: run the plugin against a fake OpenCode host and validate everything it
// registers with the official schemas from @opencode/schema (pulled in by the
// @opencode/plugin dev dependency). Usage: npm run check
//   NETLIFY_AI_RELAY_URL / NETLIFY_AI_RELAY_KEY (optional): validate the live model list instead of the fallback.
import { Schema } from "effect";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import plugin from "./dist/index.js";

const captured = { methods: [], integrations: [], provider: undefined };
const registration = { dispose: async () => {} };
const ctx = {
  options: { url: process.env.NETLIFY_AI_RELAY_URL ?? "https://relay.example.invalid" },
  integration: {
    transform: async (fn) => {
      fn({
        update: (id, edit) => { const ref = { id, name: id }; edit(ref); captured.integrations.push(ref); },
        method: { update: (input) => captured.methods.push(input) },
      });
      return registration;
    },
    connection: { active: async () => undefined, resolve: async () => undefined },
  },
  provider: {
    transform: async (fn) => { fn({ add: (input) => { captured.provider = input; } }); return registration; },
  },
};

await plugin.setup(ctx);
const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

if (plugin.id !== "opencode-netlify-ai") fail(`unexpected plugin id ${plugin.id}`);
if (!captured.integrations.some((i) => i.id === "netlify-ai")) fail("integration netlify-ai not registered");
const methodTypes = captured.methods.map((m) => m.method.type).sort();
if (methodTypes.join() !== "env,key") fail(`integration methods ${methodTypes}`);
if (!captured.provider) fail("provider not added");
Schema.decodeUnknownSync(Provider.Info)(captured.provider.info);
for (const m of captured.provider.models) Schema.decodeUnknownSync(Model.Info)(m);
const packages = new Set(captured.provider.models.map((m) => m.package));
for (const p of packages) if (!p.startsWith("aisdk:@ai-sdk/")) fail(`unexpected package ${p}`);

console.log(`OK: provider ${captured.provider.info.id} (${captured.provider.info.activation}), ${captured.provider.models.length} models valid, packages: ${[...packages].join(", ")}`);
