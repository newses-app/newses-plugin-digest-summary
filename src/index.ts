import { definePlugin, DIGEST_LIMITS, type PluginStore } from '@newses/plugin-api';
import { API_HOST, clientFor, failureText } from './claude.js';
import { compose } from './digest.js';
import { instanceSettings, userSettings } from './settings.js';
import { collectBatches, submitBatch } from './summaries.js';
import { count, remaining, usedThisMonth } from './usage.js';

/** New articles within this many seconds of the first go to Anthropic as one batch. */
export const DEBOUNCE_SECONDS = 300;

/** Of a hook's time, how long collecting ended batches may take. */
const COLLECT_MS = 20_000;
/** Of a hook's time, what is left unused, for storing what came back. */
const MARGIN_MS = 5_000;

/** The language a user's digests are written in, as the last one said; English until then. */
async function languageOf(userStorage: PluginStore | null): Promise<string> {
  const language = await userStorage?.get('language');
  return typeof language === 'string' ? language : 'en';
}

const formatted = (tokens: number) => new Intl.NumberFormat('en').format(tokens);

/**
 * Opens each user's digest with an overview of what is unread and puts a one-line summary under
 * each article, written by Claude through the Anthropic API. Articles are summarised once each,
 * in a Message Batch as they arrive; the digest asks only for the overview and what is missing.
 */
export default definePlugin({
  id: 'digest-summary',
  // Keep in step with package.json; a test checks they match.
  version: '0.1.0',
  apiVersion: '^0.1',
  scopes: ['user'],
  hosts: [API_HOST],
  settings: { instance: instanceSettings, user: userSettings },
  messages: {
    en: {
      name: 'Digest summary',
      description:
        'Opens your email digest with an overview of what is unread, and puts a one-line summary under each article, written by Claude. The title, feed name, and text of articles from your feeds go to Anthropic (api.anthropic.com) with the server’s API key, under Anthropic’s commercial terms. Articles from feeds with a login, and pages you published, are never sent.',
      'settings.apiKey': 'Anthropic API key',
      'settings.apiKey.hint':
        'From the Claude Console (platform.claude.com), under API keys. Every request is billed to it. Stored as a secret.',
      'settings.model': 'Model',
      'settings.model.hint': 'Opus writes best, Haiku costs least.',
      'settings.model.option.claude-opus-5-5': 'Claude Opus 5.5',
      'settings.model.option.claude-sonnet-5-5': 'Claude Sonnet 5.5',
      'settings.model.option.claude-haiku-5-5': 'Claude Haiku 5.5',
      'settings.effort': 'Effort',
      'settings.effort.hint': 'How much the model thinks before it writes; more costs more tokens.',
      'settings.effort.option.low': 'Low',
      'settings.effort.option.medium': 'Medium',
      'settings.effort.option.high': 'High',
      'settings.monthlyTokens': 'Tokens a month, for the server',
      'settings.monthlyTokens.hint':
        'Once used, no more requests are made until the month ends (UTC). Send test shows how many are used.',
      'settings.userMonthlyTokens': 'Tokens a month, for each user',
      'settings.userMonthlyTokens.hint':
        'Counts the summaries of the articles a user’s feeds bring first, and the user’s overviews.',
      'settings.overview': 'Open my digest with an overview',
      'settings.overview.hint': 'A few sentences on what the digest’s articles are about.',
      'settings.entrySummaries': 'Summarise each article',
      'settings.entrySummaries.hint':
        'A sentence or two under each article. Articles are summarised as they arrive.',
    },
  },
  hooks: {
    'entries.added': {
      debounceSeconds: DEBOUNCE_SECONDS,
      async run(event, context) {
        const started = Date.now();
        const client = clientFor(context.settings, context.fetch);
        const now = () => new Date();
        await collectBatches({
          client,
          store: context.storage,
          logger: context.logger,
          deadline: started + COLLECT_MS,
          signal: context.signal,
          now,
        });
        if (!context.userSettings?.entrySummaries) return;
        const allowance = await remaining(
          { instance: context.settings.monthlyTokens, user: context.settings.userMonthlyTokens },
          { instance: context.storage, user: context.userStorage },
          now(),
        );
        const { sent, tokens } = await submitBatch({
          client,
          settings: context.settings,
          store: context.storage,
          entries: event.entries,
          language: await languageOf(context.userStorage),
          allowance,
          signal: context.signal,
        }).catch((error: unknown) => {
          // What Settings → Plugins shows when the plugin is turned off for failing.
          throw new Error(failureText(error), { cause: error });
        });
        await count(context.storage, tokens, now());
        if (context.userStorage) await count(context.userStorage, tokens, now());
        if (sent > 0) context.logger.info('articles sent to be summarised', { count: sent });
      },
    },
    'digest.compose': {
      async run(input, context) {
        const started = Date.now();
        const client = clientFor(context.settings, context.fetch);
        const now = () => new Date();
        await context.userStorage?.set('language', input.language);
        await collectBatches({
          client,
          store: context.storage,
          logger: context.logger,
          deadline: started + COLLECT_MS,
          signal: context.signal,
          now,
        });
        const { outcome, ...additions } = await compose({
          client,
          settings: context.settings,
          userSettings: context.userSettings ?? userSettings.parse({}),
          input,
          storage: context.storage,
          userStorage: context.userStorage,
          logger: context.logger,
          signal: context.signal,
          deadline: started + DIGEST_LIMITS.timeoutSeconds * 1000 - MARGIN_MS,
          now,
        });
        context.logger.info('digest composed', { outcome });
        return additions;
      },
    },
    test: {
      async run(context) {
        const client = clientFor(context.settings, context.fetch);
        try {
          await client.models.retrieve(context.settings.model, null, { signal: context.signal });
        } catch (error) {
          return { ok: false, message: failureText(error) };
        }
        const now = new Date();
        const server = await usedThisMonth(context.storage, now);
        const mine = context.userStorage ? await usedThisMonth(context.userStorage, now) : 0;
        return {
          ok: true,
          message: `The API key works with ${context.settings.model}. Tokens this month: yours ${formatted(mine)} of ${formatted(context.settings.userMonthlyTokens)}, the server's ${formatted(server)} of ${formatted(context.settings.monthlyTokens)}.`,
        };
      },
    },
  },
});
