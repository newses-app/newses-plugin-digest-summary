import type Anthropic from '@anthropic-ai/sdk';
import type {
  DigestComposeInput,
  DigestEntry,
  PluginLogger,
  PluginStore,
} from '@newses/plugin-api';
import { FALLBACK_BETA, finalText } from './claude.js';
import {
  type FeedArticles,
  MERGE_SYSTEM,
  mergePrompt,
  OVERVIEW_FORMAT,
  OVERVIEW_SYSTEM,
  overviewPrompt,
  PART_FORMAT,
  PART_SYSTEM,
  type PartThemes,
  partPrompt,
  readOverview,
  readPart,
} from './prompts.js';
import { costOf, type RequestTokens, tokensIn } from './prices.js';
import type { InstanceSettings, UserSettings } from './settings.js';
import { count, remaining, tokensOf } from './usage.js';

/** Input tokens one request reads at most; a larger digest is read in parts. */
export const PART_TOKENS = 50_000;
/** Parts read at once, at most; a digest larger than this many parts has larger parts. */
export const MAX_PARTS = 6;
/** Of the time left, the share the parts may take, leaving the rest to the merge. */
const PARTS_SHARE = 0.6;
/** A request's `max_tokens`, thinking included. */
const MAX_TOKENS = 16_000;
/** Output tokens a request is expected to use, thinking included, for the budget check. */
const OUTPUT_ESTIMATE = 3_000;
/** Input tokens the parts' themes are expected to take in the request that merges them. */
const THEMES_ESTIMATE = 400;

/** The requests reading articles of `whole` tokens are expected to take: one, or parts and a merge. */
export function plannedRequests(
  partTokens: readonly number[] | null,
  whole: number,
): RequestTokens[] {
  const request = (input: number) => ({
    input,
    cacheWrite: 0,
    cacheRead: 0,
    output: OUTPUT_ESTIMATE,
  });
  if (!partTokens) return [request(whole)];
  return [
    ...partTokens.map((tokens) => request(estimateTokens(PART_SYSTEM) + tokens)),
    request(estimateTokens(MERGE_SYSTEM) + THEMES_ESTIMATE * partTokens.length),
  ];
}

/** What a digest's overview ended as, for the log. */
export type DigestOutcome = 'written' | 'refused' | 'invalid' | 'over budget' | 'failed' | 'none';

/** Whether an entry may go to the API: never one of a feed with a login, or a published page. */
export const sendable = (entry: DigestEntry) => entry.feed !== null && !entry.feed.withLogin;

/** The digest's entries the user's feed choice takes, of those that may be sent. */
export function chosen(entries: readonly DigestEntry[], settings: UserSettings): DigestEntry[] {
  const picked = new Set(settings.feeds);
  return entries.filter((entry) => {
    if (!sendable(entry)) return false;
    const id = entry.feed?.id ?? 0;
    if (settings.feedChoice === 'only') return picked.has(id);
    if (settings.feedChoice === 'except') return !picked.has(id);
    return true;
  });
}

/** Entries grouped by feed, feeds in the order their newest entry comes. */
export function byFeed(entries: readonly DigestEntry[]): FeedArticles[] {
  const feeds = new Map<number, FeedArticles>();
  for (const entry of entries) {
    if (!entry.feed) continue;
    let feed = feeds.get(entry.feed.id);
    if (!feed) {
      feed = { feed: entry.feed.title, articles: [] };
      feeds.set(entry.feed.id, feed);
    }
    feed.articles.push({ title: entry.title, excerpt: entry.excerpt });
  }
  return [...feeds.values()];
}

/** Tokens a text is about, rounded up: some 3 characters each. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);

const articleTokens = (article: FeedArticles['articles'][number]) =>
  estimateTokens(`<article><title>${article.title}</title><start>${article.excerpt ?? ''}</start>`);

/**
 * Feeds packed into parts of about `limit` tokens, each feed's articles together where they fit;
 * a feed larger than a part is split across parts.
 */
export function partsOf(feeds: readonly FeedArticles[], limit: number): FeedArticles[][] {
  const parts: FeedArticles[][] = [];
  let part: FeedArticles[] = [];
  let size = 0;
  const close = () => {
    if (part.length > 0) parts.push(part);
    part = [];
    size = 0;
  };
  for (const feed of feeds) {
    const tokens = feed.articles.reduce((sum, article) => sum + articleTokens(article), 0);
    if (size > 0 && size + tokens > limit) close();
    let piece: FeedArticles = { feed: feed.feed, articles: [] };
    for (const article of feed.articles) {
      const cost = articleTokens(article);
      if (size > 0 && size + cost > limit) {
        if (piece.articles.length > 0) part.push(piece);
        close();
        piece = { feed: feed.feed, articles: [] };
      }
      piece.articles.push(article);
      size += cost;
    }
    if (piece.articles.length > 0) part.push(piece);
  }
  close();
  return parts;
}

/** How one request ended: its text, or why it has none. */
type Asked = { ok: true; text: string } | { ok: false; outcome: 'refused' | 'invalid' | 'failed' };

/**
 * How a digest's overview would be read: the user's chosen entries of those listed and unlisted,
 * by feed, in one request or in parts, and the requests' expected tokens; null with none chosen.
 */
export function planOf(input: DigestComposeInput, userSettings: UserSettings) {
  const entries = chosen([...input.entries, ...input.unlisted], userSettings);
  if (entries.length === 0) return null;
  const feeds = byFeed(entries);
  const total = entries.length + Math.max(0, input.more - input.unlisted.length);
  const whole = estimateTokens(OVERVIEW_SYSTEM) + articlesTokens(feeds);
  const parts =
    whole <= PART_TOKENS
      ? null
      : partsOf(feeds, Math.max(PART_TOKENS, Math.ceil(whole / MAX_PARTS)));
  const planned = plannedRequests(parts?.map(articlesTokens) ?? null, whole);
  return { entries, feeds, total, parts, planned };
}

/**
 * What a digest's overview is expected to cost, making no request: its tokens, in US dollars at
 * list prices, and a note of how it would be read, or why it would add nothing.
 */
export async function estimate(options: {
  settings: InstanceSettings;
  userSettings: UserSettings;
  input: DigestComposeInput;
  storage: PluginStore;
  userStorage: PluginStore | null;
  now: () => Date;
}): Promise<{ tokens: number; costUsd: number; note: string }> {
  const { settings } = options;
  const plan = planOf(options.input, options.userSettings);
  if (!plan)
    return {
      tokens: 0,
      costUsd: 0,
      note: 'None of these articles are from feeds it reads, so it adds nothing.',
    };
  const tokens = tokensIn(plan.planned);
  const costUsd = costOf(settings.model, plan.planned);
  const left = await remaining(
    { instance: settings.monthlyTokens, user: settings.userMonthlyTokens },
    { instance: options.storage, user: options.userStorage },
    options.now(),
  );
  const formatted = (n: number) => new Intl.NumberFormat('en').format(n);
  const articles = `${formatted(plan.entries.length)} ${plan.entries.length === 1 ? 'article' : 'articles'}`;
  const requests = `${String(plan.planned.length)} ${plan.planned.length === 1 ? 'request' : 'requests'}`;
  if (left < tokens)
    return {
      tokens: 0,
      costUsd: 0,
      note: `It would read ${articles}, about ${formatted(tokens)} tokens, more than the ${formatted(left)} left of this month's budget, so it would add nothing.`,
    };
  return {
    tokens,
    costUsd,
    note: `Reads ${articles} in ${requests} to ${settings.model} at ${settings.effort} effort; the output is estimated.`,
  };
}

/**
 * One digest's overview: the user's chosen entries of those listed and unlisted, read in one
 * request, or in parts whose themes a last request turns into the overview, within the budgets.
 * Whatever a request ends as (refused, unreadable, out of time), the digest goes out without it.
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
  /** When the overview must be written by, in ms since the epoch. */
  deadline: number;
  now: () => Date;
}): Promise<{ overview: string | null; outcome: DigestOutcome }> {
  const { client, settings, input, storage, userStorage, logger, signal } = options;
  const plan = planOf(input, options.userSettings);
  if (!plan) return { overview: null, outcome: 'none' };
  const { entries, feeds, total, parts, planned } = plan;
  const budgets = { instance: settings.monthlyTokens, user: settings.userMonthlyTokens };
  if (
    (await remaining(budgets, { instance: storage, user: userStorage }, options.now())) <
    tokensIn(planned)
  )
    return { overview: null, outcome: 'over budget' };

  // Counts are read and written back, so parts answering together count one after another.
  let counting = Promise.resolve();
  const counted = (tokens: number) => {
    counting = counting.then(async () => {
      await count(storage, tokens, options.now());
      if (userStorage) await count(userStorage, tokens, options.now());
    });
    return counting;
  };

  const ask = async (
    system: string,
    prompt: string,
    format: typeof OVERVIEW_FORMAT | typeof PART_FORMAT,
    by: number,
  ): Promise<Asked> => {
    let response: Anthropic.Beta.BetaMessage;
    // Whole milliseconds: AbortSignal.timeout refuses fractions.
    const left = Math.max(1, Math.floor(by - Date.now()));
    try {
      response = await client.beta.messages.create(
        {
          model: settings.model,
          max_tokens: MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort: settings.effort, format },
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: prompt }],
        },
        {
          signal: AbortSignal.any([signal, AbortSignal.timeout(left)]),
          timeout: left,
          maxRetries: 0,
        },
      );
    } catch (error) {
      logger.warn('digest request failed', { error: String(error) });
      return { ok: false, outcome: 'failed' };
    }
    await counted(tokensOf(response.usage));
    if (response.stop_reason === 'refusal') return { ok: false, outcome: 'refused' };
    if (response.stop_reason !== 'end_turn') return { ok: false, outcome: 'invalid' };
    return { ok: true, text: finalText(response.content) };
  };

  const language = input.language;
  const frequency = input.frequency;
  if (!parts) {
    const asked = await ask(
      OVERVIEW_SYSTEM,
      overviewPrompt({ language, frequency, total, feeds }),
      OVERVIEW_FORMAT,
      options.deadline,
    );
    if (!asked.ok) return { overview: null, outcome: asked.outcome };
    const overview = readOverview(asked.text);
    return overview ? { overview, outcome: 'written' } : { overview: null, outcome: 'invalid' };
  }

  const partsBy = Date.now() + Math.floor((options.deadline - Date.now()) * PARTS_SHARE);
  const found = await Promise.all(
    parts.map(async (part): Promise<PartThemes | DigestOutcome> => {
      const asked = await ask(
        PART_SYSTEM,
        partPrompt({ language, feeds: part }),
        PART_FORMAT,
        partsBy,
      );
      if (!asked.ok) return asked.outcome;
      return readPart(asked.text) ?? 'invalid';
    }),
  );
  const failed = found.find((part) => typeof part === 'string');
  if (failed !== undefined) return { overview: null, outcome: failed };
  const asked = await ask(
    MERGE_SYSTEM,
    mergePrompt({
      language,
      frequency,
      given: entries.length,
      total,
      parts: found as PartThemes[],
    }),
    OVERVIEW_FORMAT,
    options.deadline,
  );
  if (!asked.ok) return { overview: null, outcome: asked.outcome };
  const overview = readOverview(asked.text);
  return overview ? { overview, outcome: 'written' } : { overview: null, outcome: 'invalid' };
}

/** Tokens the articles take in a request, about. */
const articlesTokens = (feeds: readonly FeedArticles[]) =>
  feeds.reduce(
    (sum, feed) =>
      sum +
      estimateTokens(`<feed><name>${feed.feed}</name></feed>`) +
      feed.articles.reduce((n, article) => n + articleTokens(article), 0),
    0,
  );
