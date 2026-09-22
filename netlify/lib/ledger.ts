import { getStore } from "@netlify/blobs";
import { env, flag } from "./env.ts";
import type { Usage } from "./usage.ts";

export type DayUsage = {
  date: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  models: Record<string, number>;
  updated_at?: string;
};

const STORE = "netlify-ai-relay-ledger";

export const ledgerEnabled = () => flag("RELAY_LEDGER", true);
export const today = () => new Date().toISOString().slice(0, 10);
export const dailyTokenBudget = (): number | undefined => {
  const raw = env("RELAY_DAILY_TOKEN_BUDGET");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const empty = (date: string): DayUsage => ({ date, requests: 0, input_tokens: 0, output_tokens: 0, models: {} });
const blobKey = (keyName: string, date: string) => `${keyName}/${date}`;

export async function readDay(keyName: string, date = today()): Promise<DayUsage> {
  try {
    const stored = (await getStore(STORE).get(blobKey(keyName, date), { type: "json", consistency: "strong" })) as DayUsage | null;
    return stored ?? empty(date);
  } catch {
    return empty(date);
  }
}

/** Approximate by design: concurrent requests may race on the read-modify-write. */
export async function record(keyName: string, model: string | undefined, usage: Usage | undefined): Promise<string | undefined> {
  try {
    const date = today();
    const day = await readDay(keyName, date);
    day.requests += 1;
    day.input_tokens += usage?.input ?? 0;
    day.output_tokens += usage?.output ?? 0;
    const m = model ?? "unknown";
    day.models[m] = (day.models[m] ?? 0) + 1;
    day.updated_at = new Date().toISOString();
    await getStore(STORE).setJSON(blobKey(keyName, date), day);
    return undefined;
  } catch (err) {
    console.error("ledger write failed", err);
    return String(err);
  }
}

export function overBudget(day: DayUsage, budget: number | undefined): boolean {
  if (!budget) return false;
  return day.input_tokens + day.output_tokens >= budget;
}
