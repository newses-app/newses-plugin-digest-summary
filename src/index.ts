import { definePlugin, DIGEST_LIMITS } from '@newses/plugin-api';
import { API_HOST, clientFor, failureText } from './claude.js';
import { compose, estimate } from './digest.js';
import { instanceSettings, userSettings } from './settings.js';
import { usedThisMonth } from './usage.js';

/** Of the digest's time, what is left unused, for counting what came back. */
const MARGIN_MS = 3_000;

const formatted = (tokens: number) => new Intl.NumberFormat('en').format(tokens);

/**
 * Opens each user's email digest with an overview of what their unread articles are about, in
 * topic sections whose points link the articles they draw on, written by Claude through the
 * Anthropic API from the titles and excerpts of every unread article the digest counts, of the
 * feeds the user chooses, with the sections, length, style, and instructions the user chooses.
 */
export default definePlugin({
  id: 'digest-summary',
  // Keep in step with package.json; a test checks they match.
  version: '0.2.0',
  apiVersion: '^0.1.2',
  scopes: ['user'],
  hosts: [API_HOST],
  settings: { instance: instanceSettings, user: userSettings },
  messages: {
    en: {
      name: 'Digest summary',
      description:
        'Opens your email digest with an overview of what your unread articles are about, written by Claude: a lead on their common themes, then topic sections whose points link the articles they draw on. The title, feed name, and first lines of the unread articles of the feeds you choose go to Anthropic (api.anthropic.com) with the server’s API key, under Anthropic’s commercial terms, with your sections and instructions. Articles from feeds with a login, and pages you published, are never sent, nor are links.',
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
        'How much the model thinks before it writes; more costs more tokens and takes longer, and a digest waits at most five minutes.',
      'settings.effort.option.low': 'Low',
      'settings.effort.option.medium': 'Medium',
      'settings.effort.option.high': 'High',
      'settings.monthlyTokens': 'Tokens a month, for the server',
      'settings.monthlyTokens.hint':
        'Once used, no more overviews are written until the month ends (UTC). Send test shows how many are used.',
      'settings.userMonthlyTokens': 'Tokens a month, for each user',
      'settings.userMonthlyTokens.hint':
        'A digest of 1,000 unread articles reads about 100,000 tokens.',
      'settings.allowInstructions': 'Users may add their own instructions',
      'settings.allowInstructions.hint':
        'When off, the instructions users wrote under For me are kept but not sent.',
      'settings.feedChoice': 'Feeds to read',
      'settings.feedChoice.option.all': 'All my feeds',
      'settings.feedChoice.option.only': 'Only the feeds below',
      'settings.feedChoice.option.except': 'All but the feeds below',
      'settings.feeds': 'Feeds',
      'settings.feeds.hint': 'Used when only some feeds are read, or all but some.',
      'settings.sections': 'Sections',
      'settings.sections.hint':
        'The topics stories are sorted into, in this order; sections nothing fits are left out. Name a section in any language: its heading is written in your digest’s. With none, the default sections are used.',
      'settings.sections.item.name': 'Name',
      'settings.sections.item.about': 'What goes in it',
      'settings.length': 'Length',
      'settings.length.hint': 'Longer overviews cost more tokens.',
      'settings.length.option.brief': 'Brief: up to 2 short points a section',
      'settings.length.option.standard': 'Standard: up to 3 points a section',
      'settings.length.option.detailed': 'Detailed: up to 5 longer points a section',
      'settings.style': 'Points shown as',
      'settings.style.option.paragraphs': 'Paragraphs',
      'settings.style.option.bullets': 'Bullets',
      'settings.lead': 'Open with a lead on the common themes',
      'settings.instructions': 'Your instructions',
      'settings.instructions.hint':
        'What to focus on, leave out, or how to write, such as “Skip celebrity news; explain jargon.” Up to 1,000 characters, sent to Anthropic with your articles. They cannot change what is sent or the overview’s format.',
      'action.estimate': 'Estimate cost',
      'action.estimate.hint':
        'What the overview of a test digest of your unread articles from the last day would cost now, without sending it.',
    },
  },
  hooks: {
    'digest.compose': {
      async run(input, context) {
        const started = Date.now();
        const { overview, sections, outcome } = await compose({
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
        return { overview, sections };
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
  actions: {
    // What digest.compose would cost for a test digest now, making no request.
    estimate: {
      digest: true,
      run: async (context, digest) => ({
        ok: true,
        message: digest
          ? await estimate({
              settings: context.settings,
              userSettings: context.userSettings ?? userSettings.parse({}),
              input: digest,
              storage: context.storage,
              userStorage: context.userStorage,
              now: () => new Date(),
            })
          : 'No test digest to estimate.',
      }),
    },
  },
});
