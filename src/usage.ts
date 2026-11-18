import type { PluginStore } from '@newses/plugin-api';

/** Tokens a response used, every attempt counted: input, cache writes and reads, and output. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Every token of a response's usage; with `iterations`, every attempt's, fallbacks included. */
export function tokensOf(usage: Usage & { iterations?: readonly Usage[] | null }): number {
  const attempts = usage.iterations?.length ? usage.iterations : [usage];
  return attempts.reduce(
    (sum, attempt) =>
      sum +
      attempt.input_tokens +
      attempt.output_tokens +
      (attempt.cache_creation_input_tokens ?? 0) +
      (attempt.cache_read_input_tokens ?? 0),
    0,
  );
}

/** The month usage is counted in, in UTC: `2026-11`. */
export const monthOf = (now: Date) => now.toISOString().slice(0, 7);

const usageKey = (now: Date) => `usage:${monthOf(now)}`;

/** Kept a year, the longest storage keeps a value. */
const USAGE_TTL_SECONDS = 366 * 24 * 60 * 60;

/** The tokens counted in a store this month. */
export async function usedThisMonth(store: PluginStore, now: Date): Promise<number> {
  const value = await store.get(usageKey(now));
  return typeof value === 'number' ? value : 0;
}

/** Adds tokens to a store's count for this month; a negative number corrects an estimate. */
export async function count(store: PluginStore, tokens: number, now: Date): Promise<void> {
  if (tokens === 0) return;
  const used = await usedThisMonth(store, now);
  await store.set(usageKey(now), Math.max(0, used + tokens), { ttlSeconds: USAGE_TTL_SECONDS });
}

/** What is left of the instance's and the user's budgets this month, the smaller of the two. */
export async function remaining(
  budgets: { instance: number; user: number },
  stores: { instance: PluginStore; user: PluginStore | null },
  now: Date,
): Promise<number> {
  const instance = budgets.instance - (await usedThisMonth(stores.instance, now));
  const user = stores.user ? budgets.user - (await usedThisMonth(stores.user, now)) : Infinity;
  return Math.max(0, Math.min(instance, user));
}
