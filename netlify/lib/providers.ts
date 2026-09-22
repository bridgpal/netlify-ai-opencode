import { env } from "./env.ts";

export type ProviderId = "anthropic" | "openai" | "gemini" | "openrouter";

export type Provider = {
  id: ProviderId;
  prefix: `/${string}`;
  baseEnv: string;
  keyEnv: string;
  /** Header(s) the upstream expects the gateway key in. */
  authHeaders: (key: string) => Record<string, string>;
};

export const PROVIDERS: Record<ProviderId, Provider> = {
  anthropic: {
    id: "anthropic",
    prefix: "/anthropic",
    baseEnv: "ANTHROPIC_BASE_URL",
    keyEnv: "ANTHROPIC_API_KEY",
    authHeaders: (key) => ({ "x-api-key": key }),
  },
  openai: {
    id: "openai",
    prefix: "/openai",
    baseEnv: "OPENAI_BASE_URL",
    keyEnv: "OPENAI_API_KEY",
    authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
  },
  gemini: {
    id: "gemini",
    prefix: "/gemini",
    baseEnv: "GOOGLE_GEMINI_BASE_URL",
    keyEnv: "GEMINI_API_KEY",
    authHeaders: (key) => ({ "x-goog-api-key": key }),
  },
  openrouter: {
    id: "openrouter",
    prefix: "/openrouter",
    baseEnv: "OPENROUTER_BASE_URL",
    keyEnv: "OPENROUTER_API_KEY",
    authHeaders: (key) => ({ authorization: `Bearer ${key}` }),
  },
};

/** Split `/anthropic/v1/messages` into the provider and the upstream path `/v1/messages`. */
export function resolve(pathname: string): { provider: Provider; rest: string } | undefined {
  for (const provider of Object.values(PROVIDERS)) {
    if (pathname === provider.prefix || pathname.startsWith(provider.prefix + "/")) {
      return { provider, rest: pathname.slice(provider.prefix.length) || "/" };
    }
  }
  return undefined;
}

/** Gateway credentials for a provider, read at request time. */
export function credentials(provider: Provider): { base: string; key: string } | undefined {
  const base = env(provider.baseEnv);
  const key = env(provider.keyEnv);
  if (!base || !key) return undefined;
  return { base: base.replace(/\/+$/, ""), key };
}
