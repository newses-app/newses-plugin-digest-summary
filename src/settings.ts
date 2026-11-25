import { feeds, secret } from '@newses/plugin-api';
import { z } from 'zod';

/** The models an admin can choose: the current Opus, Sonnet, and Haiku. */
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

/** How much the model thinks before it writes. */
export const EFFORTS = ['low', 'medium', 'high'] as const;

/** Which of a user's feeds the overview reads. */
export const FEED_CHOICES = ['all', 'only', 'except'] as const;

const tokens = z.number().int().min(0).max(1_000_000_000);

/** What an admin sets for the server: the API key, the model, and the monthly budgets. */
export const instanceSettings = z.object({
  apiKey: secret(),
  model: z.enum(MODELS).default('claude-opus-5-5'),
  effort: z.enum(EFFORTS).default('low'),
  monthlyTokens: tokens.default(10_000_000),
  userMonthlyTokens: tokens.default(1_000_000),
});

/** What each user chooses: all their feeds, only some, or all but some. */
export const userSettings = z.object({
  feedChoice: z.enum(FEED_CHOICES).default('all'),
  feeds: feeds(),
});

export type InstanceSettings = z.output<typeof instanceSettings>;
export type UserSettings = z.output<typeof userSettings>;
