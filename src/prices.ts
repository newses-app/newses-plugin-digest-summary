import type { InstanceSettings } from './settings.js';

/** US dollars per million tokens of one kind. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * Anthropic's list prices for the models an admin can choose, standard tier, in US dollars per
 * million tokens (https://platform.claude.com/docs/en/about-claude/pricing, November 2026).
 * Haiku costs more for a request whose prompt is over `over.prompt` tokens. Discounts, other
 * tiers, and fallbacks to other models are not counted, so costs are estimates.
 */
const PRICES: Record<InstanceSettings['model'], Price & { over?: Price & { prompt: number } }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    over: { prompt: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
};
/** Writing the prompt cache (5 minutes) costs this many times input. */
const CACHE_WRITE = 1.25;

/** One request's tokens, by how they are billed; estimated before a digest. */
export interface RequestTokens {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** What requests cost with a model, in US dollars. */
export function costOf(model: InstanceSettings['model'], requests: readonly RequestTokens[]) {
  return requests.reduce((sum, request) => {
    const prompt = request.input + request.cacheWrite + request.cacheRead;
    const base = PRICES[model];
    const price = base.over && prompt > base.over.prompt ? base.over : base;
    return (
      sum +
      (request.input * price.input +
        request.cacheWrite * price.input * CACHE_WRITE +
        request.cacheRead * price.cacheRead +
        request.output * price.output) /
        1_000_000
    );
  }, 0);
}

/** Every token of some requests. */
export const tokensIn = (requests: readonly RequestTokens[]) =>
  requests.reduce((sum, r) => sum + r.input + r.cacheWrite + r.cacheRead + r.output, 0);

/** US dollars for a message: `about $0.95`, or `less than $0.01`. */
export const dollars = (amount: number) =>
  amount < 0.005 ? 'less than $0.01' : `about $${amount.toFixed(2)}`;
