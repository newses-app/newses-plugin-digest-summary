import { definePlugin, DIGEST_LIMITS } from '@newses/plugin-api';
import { API_HOST, clientFor, failureText } from './claude.js';
import { compose, estimate } from './digest.js';
import { instanceSettings, userSettings } from './settings.js';
import { usedThisMonth } from './usage.js';

/** Of the digest's time, what is left unused, for counting what came back. */
const MARGIN_MS = 3_000;

const formatted = (tokens: number) => new Intl.NumberFormat('en').format(tokens);

/**
 * Opens each user's email digest with an overview of what their unread articles are about,
 * written by Claude through the Anthropic API from the titles and excerpts of every unread
 * article the digest counts, of the feeds the user chooses.
 */
export default definePlugin({
  id: 'digest-summary',
  // Keep in step with package.json; a test checks they match.
  version: '0.1.0',
  apiVersion: '^0.1.1',
  scopes: ['user'],
  hosts: [API_HOST],
  settings: { instance: instanceSettings, user: userSettings },
  messages: {
    en: {
      name: 'Digest summary',
      description:
        'Opens your email digest with an overview of what your unread articles are about: their common themes, then other notable stories, written by Claude. The title, feed name, and first lines of the unread articles of the feeds you choose go to Anthropic (api.anthropic.com) with the server’s API key, under Anthropic’s commercial terms. Articles from feeds with a login, and pages you published, are never sent.',
      'settings.apiKey': 'Anthropic API key',
      'settings.apiKey.hint':
        'From the Claude Console (platform.claude.com), under API keys. Every request is billed to it. Stored as a secret.',
      'settings.model': 'Model',
      'settings.model.hint': 'Opus writes best, Haiku costs least.',
      'settings.model.option.claude-opus-5-5': 'Claude Opus 5.5',
      'settings.model.option.claude-sonnet-5-5': 'Claude Sonnet 5.5',
      'settings.model.option.claude-haiku-5-5': 'Claude Haiku 5.5',
      'settings.effort': 'Effort',
      'settings.effort.hint':
        'How much the model thinks before it writes; more costs more tokens and takes longer, and a digest waits at most a minute.',
      'settings.effort.option.low': 'Low',
      'settings.effort.option.medium': 'Medium',
      'settings.effort.option.high': 'High',
      'settings.monthlyTokens': 'Tokens a month, for the server',
      'settings.monthlyTokens.hint':
        'Once used, no more overviews are written until the month ends (UTC). Send test shows how many are used.',
      'settings.userMonthlyTokens': 'Tokens a month, for each user',
      'settings.userMonthlyTokens.hint':
        'A digest of 1,000 unread articles reads about 100,000 tokens.',
      'settings.feedChoice': 'Feeds to read',
      'settings.feedChoice.option.all': 'All my feeds',
      'settings.feedChoice.option.only': 'Only the feeds below',
      'settings.feedChoice.option.except': 'All but the feeds below',
      'settings.feeds': 'Feeds',
      'settings.feeds.hint': 'Used when only some feeds are read, or all but some.',
    },
  },
  hooks: {
    'digest.compose': {
      async run(input, context) {
        const started = Date.now();
        const { overview, outcome } = await compose({
          client: clientFor(context.settings, context.fetch),
          settings: context.settings,
          userSettings: context.userSettings ?? userSettings.parse({}),
          input,
          storage: context.storage,
          userStorage: context.userStorage,
          logger: context.logger,
          signal: context.signal,
          deadline: started + DIGEST_LIMITS.timeoutSeconds * 1000 - MARGIN_MS,
          now: () => new Date(),
        });
        context.logger.info('digest composed', { outcome });
        return { overview };
      },
    },
    // What digest.compose would cost, for a test digest's preview; makes no request.
    'digest.estimate': {
      run: (input, context) =>
        estimate({
          settings: context.settings,
          userSettings: context.userSettings ?? userSettings.parse({}),
          input,
          storage: context.storage,
          userStorage: context.userStorage,
          now: () => new Date(),
        }),
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
