import { DIGEST_LIMITS, feeds, multiline, secret } from '@newses/plugin-api';
import { z } from 'zod';

/** The models an admin can choose: the current Opus, Sonnet, and Haiku. */
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

/** How much the model thinks before it writes. */
export const EFFORTS = ['low', 'medium', 'high'] as const;

/** Which of a user's feeds the overview reads. */
export const FEED_CHOICES = ['all', 'only', 'except'] as const;

/** How long the overview is. */
export const LENGTHS = ['brief', 'standard', 'detailed'] as const;

/** How each section's points are shown: as paragraphs, or as a bulleted list. */
export const STYLES = ['paragraphs', 'bullets'] as const;

/** Characters of a user's own instructions, at most. */
export const INSTRUCTIONS_LENGTH = 1000;

/** The sections a user starts with: a name, and what goes in it. */
export const DEFAULT_SECTIONS = [
  { name: 'World', about: 'International news, conflicts, and diplomacy' },
  { name: 'Politics', about: 'Governments, elections, laws, and policy' },
  { name: 'Business', about: 'Companies, markets, the economy, and work' },
  { name: 'Technology', about: 'Computing, the internet, AI, gadgets, and the tech industry' },
  { name: 'Science', about: 'Research, space, the environment, and climate' },
  { name: 'Health', about: 'Medicine, public health, and wellbeing' },
  { name: 'Sports', about: 'Games, results, athletes, and leagues' },
  { name: 'Culture', about: 'Arts, entertainment, books, games, and media' },
  { name: 'Other', about: 'Notable stories that fit no other section' },
] as const;

const tokens = z.number().int().min(0).max(1_000_000_000);

/** What an admin sets for the server: the API key, the model, the budgets, and what users may add. */
export const instanceSettings = z.object({
  apiKey: secret(),
  model: z.enum(MODELS).default('claude-opus-5-5'),
  effort: z.enum(EFFORTS).default('low'),
  monthlyTokens: tokens.default(10_000_000),
  userMonthlyTokens: tokens.default(1_000_000),
  allowInstructions: z.boolean().default(true),
});

/** A section of the overview, by name, with what goes in it. */
export const section = z.object({
  name: z.string().trim().min(1).max(60),
  about: z.string().trim().max(200).default(''),
});

/**
 * What each user chooses: all their feeds, only some, or all but some; the sections, the length
 * and style, whether a lead opens it, and instructions of their own.
 */
export const userSettings = z.object({
  feedChoice: z.enum(FEED_CHOICES).default('all'),
  feeds: feeds(),
  sections: z
    .array(section)
    .max(DIGEST_LIMITS.sections)
    .default(() => DEFAULT_SECTIONS.map((s) => ({ ...s }))),
  length: z.enum(LENGTHS).default('standard'),
  style: z.enum(STYLES).default('paragraphs'),
  lead: z.boolean().default(true),
  instructions: multiline().max(INSTRUCTIONS_LENGTH).default(''),
});

export type InstanceSettings = z.output<typeof instanceSettings>;
export type UserSettings = z.output<typeof userSettings>;
export type Section = z.output<typeof section>;
