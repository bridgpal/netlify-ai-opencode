import { env } from "./env.ts";

export type RelayKey = { name: string };
export type AuthResult =
  | { ok: true; key: RelayKey }
  | { ok: false; status: 401 | 503; message: string };

type Entry = { name: string; secret: string };

/**
 * RELAY_KEYS holds the keys callers must present, separated by commas or newlines.
 * Each entry is `name:secret` or just `secret` (auto-named key-1, key-2, ...).
 * The name shows up in the usage ledger and in /whoami.
 */
function entries(): Entry[] {
  const raw = env("RELAY_KEYS") ?? "";
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const idx = entry.indexOf(":");
      if (idx > 0) return { name: entry.slice(0, idx).trim(), secret: entry.slice(idx + 1).trim() };
      return { name: `key-${i + 1}`, secret: entry };
    })
    .filter((e) => e.secret.length > 0);
}

/** The key a client presented, in any of the header shapes the provider SDKs use. */
export function presentedKey(req: Request): string | undefined {
  const authz = req.headers.get("authorization");
  if (authz && /^bearer\s+/i.test(authz)) return authz.replace(/^bearer\s+/i, "").trim();
  return (
    req.headers.get("x-api-key") ??
    req.headers.get("x-goog-api-key") ??
    new URL(req.url).searchParams.get("key") ??
    undefined
  );
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

export async function authenticate(req: Request): Promise<AuthResult> {
  const keys = entries();
  if (keys.length === 0) {
    return { ok: false, status: 503, message: "Relay is not configured: set the RELAY_KEYS environment variable." };
  }
  const presented = presentedKey(req);
  if (!presented) return { ok: false, status: 401, message: "Missing relay key." };

  const digest = await sha256(presented);
  let match: Entry | undefined;
  // Check every entry so timing does not reveal which one (if any) matched.
  for (const entry of keys) {
    if (equal(digest, await sha256(entry.secret))) match = entry;
  }
  if (!match) return { ok: false, status: 401, message: "Invalid relay key." };
  return { ok: true, key: { name: match.name } };
}

export function deny(result: Extract<AuthResult, { ok: false }>): Response {
  return Response.json(
    { error: { type: result.status === 401 ? "authentication_error" : "relay_unconfigured", message: result.message } },
    { status: result.status, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
  );
}
