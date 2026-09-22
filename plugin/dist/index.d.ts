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
 * This module deliberately has no runtime dependency on @opencode/plugin: OpenCode
 * only needs a default export shaped { id, setup }.
 */
type Registration = {
    dispose: () => Promise<void>;
};
type Credential = {
    type: "key";
    key: string;
} | {
    type: "oauth";
    access: string;
} | undefined;
type Connection = {
    type: "credential";
    id: string;
} | {
    type: "env";
    name: string;
} | undefined;
type ProviderInfo = {
    id: string;
    name: string;
    activation: "auto" | "enabled" | "disabled";
    package: string;
    integrationID?: string;
    settings?: Record<string, unknown>;
};
type ModelInfo = {
    id: string;
    modelID: string;
    providerID: string;
    name: string;
    package?: string;
    settings?: Record<string, unknown>;
    capabilities: {
        tools: boolean;
        input: string[];
        output: string[];
    };
    variants: unknown[];
    time: {
        released: number;
    };
    cost: unknown[];
    status: "active";
    enabled: boolean;
    limit: {
        context: number;
        output: number;
    };
};
type IntegrationMethod = {
    type: "key";
    label?: string;
} | {
    type: "env";
    names: string[];
};
type Context = {
    options?: Record<string, unknown>;
    integration: {
        transform(fn: (editor: {
            update(id: string, fn: (i: {
                id: string;
                name: string;
            }) => void): void;
            method: {
                update(input: {
                    integrationID: string;
                    method: IntegrationMethod;
                }): void;
            };
        }) => void): Promise<Registration>;
        connection: {
            active(integrationID: string): Promise<Connection>;
            resolve(connection: NonNullable<Connection>): Promise<Credential>;
        };
    };
    provider: {
        transform(fn: (editor: {
            add(input: {
                info: ProviderInfo;
                models: ModelInfo[];
            }): void;
        }) => void): Promise<Registration>;
    };
};
declare const _default: {
    id: string;
    setup: (ctx: Context) => Promise<void>;
};
export default _default;
