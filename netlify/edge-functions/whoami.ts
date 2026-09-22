import type { Config } from "@netlify/edge-functions";
import { authenticate, deny } from "../lib/auth.ts";
import { dailyTokenBudget, ledgerEnabled, readDay } from "../lib/ledger.ts";
import { env } from "../lib/env.ts";

export default async (req: Request) => {
  const auth = await authenticate(req);
  if (!auth.ok) return deny(auth);
  const usage = ledgerEnabled() ? await readDay(auth.key.name) : undefined;
  return Response.json(
    {
      key: auth.key.name,
      ledger: ledgerEnabled(),
      daily_token_budget: dailyTokenBudget() ?? null,
      models_allow: env("RELAY_MODELS_ALLOW") ?? null,
      today: usage ?? null,
    },
    { headers: { "cache-control": "no-store" } },
  );
};

export const config: Config = { path: "/whoami" };
