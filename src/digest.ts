import type Anthropic from '@anthropic-ai/sdk';
import type {
  DigestAdditions,
  DigestComposeInput,
  PluginLogger,
  PluginStore,
} from '@newses/plugin-api';
import { FALLBACK_BETA, finalText } from './claude.js';
import {
  DIGEST_FORMAT,
  DIGEST_SYSTEM,
  type DigestArticle,
  digestPrompt,
  readDigest,
} from './prompts.js';
import type { InstanceSettings, UserSettings } from './settings.js';
import { keepSummary, sendable, storedSummary } from './summaries.js';
import { count, remaining, tokensOf } from './usage.js';

/** A digest request's `max_tokens`, thinking included. */
const DIGEST_MAX_TOKENS = 8000;

/** What a digest request ended as, for the log. */
export type DigestOutcome = 'written' | 'refused' | 'invalid' | 'over budget' | 'failed' | 'none';

/**
 * The digest's additions: the summaries kept for its entries, and a request for its overview and
 * the summaries it lacks, within the budgets. Whatever the request ends as (refused, unreadable,
 * out of time, over budget), the kept summaries are added.
 */
export async function compose(options: {
  client: Anthropic;
  settings: InstanceSettings;
  userSettings: UserSettings;
  input: DigestComposeInput;
  storage: PluginStore;
  userStorage: PluginStore | null;
  logger: PluginLogger;
  signal: AbortSignal;
  /** When the request must have answered by, in ms since the epoch. */
  deadline: number;
  now: () => Date;
}): Promise<DigestAdditions & { outcome: DigestOutcome }> {
  const { client, settings, userSettings, input, storage, userStorage, signal } = options;
  const articles: DigestArticle[] = [];
  const known = new Map<number, string>();
  await Promise.all(
    input.entries.filter(sendable).map(async (entry) => {
      const kept = await storedSummary(storage, input.language, entry.contentHash);
      const summary = kept && kept !== 'pending' ? kept.summary : null;
      if (summary) known.set(entry.id, summary);
      articles.push({
        id: entry.id,
        title: entry.title,
        feed: entry.feed?.title ?? '',
        summary,
        excerpt: entry.excerpt,
        // Refused before (kept as null) is not asked again.
        needsSummary: userSettings.entrySummaries && (kept === undefined || kept === 'pending'),
      });
    }),
  );
  const order = new Map(input.entries.map((entry, index) => [entry.id, index]));
  articles.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const additions = (overview: string | null, written: { id: number; summary: string }[] = []) => ({
    overview,
    entries: userSettings.entrySummaries
      ? [
          ...[...known].map(([id, text]) => ({ id, text })),
          ...written.map((entry) => ({ id: entry.id, text: entry.summary })),
        ]
      : null,
  });

  const wanted = userSettings.overview || articles.some((article) => article.needsSummary);
  if (articles.length === 0 || !wanted) return { ...additions(null), outcome: 'none' };
  const budgets = { instance: settings.monthlyTokens, user: settings.userMonthlyTokens };
  const stores = { instance: storage, user: userStorage };
  if ((await remaining(budgets, stores, options.now())) <= 0)
    return { ...additions(null), outcome: 'over budget' };

  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create(
      {
        model: settings.model,
        max_tokens: DIGEST_MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        output_config: { effort: settings.effort, format: DIGEST_FORMAT },
        system: [{ type: 'text', text: DIGEST_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: digestPrompt({
              language: input.language,
              frequency: input.frequency,
              overview: userSettings.overview,
              more: input.more,
              articles,
            }),
          },
        ],
      },
      {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(0, options.deadline - Date.now())),
        ]),
        timeout: Math.max(1, options.deadline - Date.now()),
        maxRetries: 0,
      },
    );
  } catch (error) {
    options.logger.warn('digest request failed', { error: String(error) });
    return { ...additions(null), outcome: 'failed' };
  }

  const used = tokensOf(response.usage);
  await count(storage, used, options.now());
  if (userStorage) await count(userStorage, used, options.now());

  if (response.stop_reason === 'refusal') return { ...additions(null), outcome: 'refused' };
  const answer =
    response.stop_reason === 'end_turn' ? readDigest(finalText(response.content)) : null;
  if (!answer) return { ...additions(null), outcome: 'invalid' };

  const asked = new Map(
    articles.filter((article) => article.needsSummary).map((article) => [article.id, article]),
  );
  const written = answer.entries.filter((entry) => asked.has(entry.id));
  const hashes = new Map(input.entries.map((entry) => [entry.id, entry.contentHash]));
  await Promise.all(
    written.map((entry) =>
      keepSummary(storage, input.language, hashes.get(entry.id) ?? '', entry.summary),
    ),
  );
  return {
    ...additions(userSettings.overview && answer.overview ? answer.overview : null, written),
    outcome: 'written',
  };
}
