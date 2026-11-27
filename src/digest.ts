import Anthropic from '@anthropic-ai/sdk';
import {
  DIGEST_LIMITS,
  type DigestComposeInput,
  type DigestEntry,
  type DigestSection,
  type PluginLogger,
  type PluginStore,
} from '@newses/plugin-api';
import { FALLBACK_BETA, finalText } from './claude.js';
import {
  type FeedArticles,
  MERGE_SYSTEM,
  mergePrompt,
  type OutputFormat,
  type Overview,
  OVERVIEW_SYSTEM,
  overviewPrompt,
  PART_SYSTEM,
  partFormat,
  type PartThemes,
  partPrompt,
  preferencesText,
  readPart,
  readSections,
  sectionsFormat,
  sectionsOf,
} from './prompts.js';
import { costOf, dollars, type RequestTokens, tokensIn } from './prices.js';
import {
  DEFAULT_SECTIONS,
  INSTRUCTIONS_LENGTH,
  type InstanceSettings,
  type UserSettings,
} from './settings.js';
import { count, remaining, tokensOf } from './usage.js';

/** Input tokens one request reads at most; a larger digest is read in parts. */
export const PART_TOKENS = 50_000;
/** Parts read at once, at most; a digest larger than this many parts has larger parts. */
export const MAX_PARTS = 6;
/** Of the time left, the share the parts may take, leaving the rest to the merge. */
const PARTS_SHARE = 0.6;
/** A request's `max_tokens`, thinking included. */
const MAX_TOKENS = 16_000;
/**
 * Output tokens a request is expected to use, thinking included, for the budget check: a part's,
 * and the overview's by length.
 */
const PART_OUTPUT_ESTIMATE = 3_000;
export const OUTPUT_ESTIMATE = { brief: 3_000, standard: 5_000, detailed: 8_000 } as const;
/** Input tokens the parts' themes are expected to take in the request that merges them. */
const THEMES_ESTIMATE = 800;

/**
 * The requests reading articles of `whole` tokens are expected to take: one, or parts and a
 * merge; `preferences` is the tokens of the reader's preferences each request carries.
 */
export function plannedRequests(
  partTokens: readonly number[] | null,
  whole: number,
  options: { preferences: number; length: UserSettings['length'] },
): RequestTokens[] {
  const request = (input: number, output = OUTPUT_ESTIMATE[options.length]) => ({
    input: input + options.preferences,
    cacheWrite: 0,
    cacheRead: 0,
    output,
  });
  if (!partTokens) return [request(whole)];
  return [
    ...partTokens.map((tokens) =>
      request(estimateTokens(PART_SYSTEM) + tokens, PART_OUTPUT_ESTIMATE),
    ),
    request(estimateTokens(MERGE_SYSTEM) + THEMES_ESTIMATE * partTokens.length),
  ];
}

/** What a digest's overview ended as, for the log. */
export type DigestOutcome =
  | 'written'
  /** Written from the parts that answered, saying how many did not. */
  | 'partial'
  | 'refused'
  | 'invalid'
  | 'over budget'
  | 'failed'
  | 'timed out'
  | 'none';

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

/**
 * Entries grouped by feed, feeds in the order their newest entry comes, each entry with a ref
 * (`a1`, `a2`, … in the order given), and the entry id each ref names.
 */
export function byFeed(entries: readonly DigestEntry[]): {
  feeds: FeedArticles[];
  ids: Map<string, number>;
} {
  const feeds = new Map<number, FeedArticles>();
  const ids = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.feed) continue;
    let feed = feeds.get(entry.feed.id);
    if (!feed) {
      feed = { feed: entry.feed.title, articles: [] };
      feeds.set(entry.feed.id, feed);
    }
    const ref = `a${String(ids.size + 1)}`;
    ids.set(ref, entry.id);
    feed.articles.push({ ref, title: entry.title, excerpt: entry.excerpt });
  }
  return { feeds: [...feeds.values()], ids };
}

/** Tokens a text is about, rounded up: some 3 characters each. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);

const articleTokens = (article: FeedArticles['articles'][number]) =>
  estimateTokens(
    `<article ref="${article.ref}"><title>${article.title}</title><start>${article.excerpt ?? ''}</start>`,
  );

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
type Asked =
  | { ok: true; text: string }
  | { ok: false; outcome: 'refused' | 'invalid' | 'failed' | 'timed out' };

/**
 * The reader's preferences as the requests give them: the sections, and the second system block
 * of the overview's requests and of the parts'. Their instructions only when the server allows.
 */
export function preferencesOf(settings: InstanceSettings, userSettings: UserSettings) {
  const sections = sectionsOf(userSettings, DEFAULT_SECTIONS);
  const instructions = settings.allowInstructions
    ? userSettings.instructions.trim().slice(0, INSTRUCTIONS_LENGTH) || null
    : null;
  const options = {
    sections,
    length: userSettings.length,
    lead: userSettings.lead,
    instructions,
  };
  return {
    sections,
    names: sections.map((section) => section.name),
    overview: preferencesText(options),
    parts: preferencesText({ ...options, forParts: true }),
  };
}

/**
 * How a digest's overview would be read: the user's chosen entries of those listed and unlisted,
 * by feed with their refs, the reader's preferences, in one request or in parts, and the
 * requests' expected tokens; null with none chosen.
 */
export function planOf(
  input: DigestComposeInput,
  settings: InstanceSettings,
  userSettings: UserSettings,
) {
  const entries = chosen([...input.entries, ...input.unlisted], userSettings);
  if (entries.length === 0) return null;
  const { feeds, ids } = byFeed(entries);
  const preferences = preferencesOf(settings, userSettings);
  const total = entries.length + Math.max(0, input.more - input.unlisted.length);
  const whole = estimateTokens(OVERVIEW_SYSTEM) + articlesTokens(feeds);
  const parts =
    whole <= PART_TOKENS
      ? null
      : partsOf(feeds, Math.max(PART_TOKENS, Math.ceil(whole / MAX_PARTS)));
  const planned = plannedRequests(parts?.map(articlesTokens) ?? null, whole, {
    preferences: estimateTokens(preferences.overview),
    length: userSettings.length,
  });
  return { entries, feeds, ids, preferences, total, parts, planned };
}

/** The overview as the digest takes it: the lead as its overview, then its sections. */
export function additionsOf(
  overview: Overview,
  userSettings: Pick<UserSettings, 'lead' | 'style'>,
): { overview: string | null; sections: DigestSection[] } {
  return {
    overview: userSettings.lead && overview.lead ? overview.lead : null,
    sections: overview.sections.map((section) => ({
      heading: section.heading,
      list: userSettings.style === 'bullets',
      items: section.points.map((point) => ({ text: point.text, entries: point.entries })),
    })),
  };
}

/**
 * What the overview of a digest is expected to cost, making no request, as plain text: how it
 * would be read, its tokens, and US dollars at list prices, or why it would add nothing.
 */
export async function estimate(options: {
  settings: InstanceSettings;
  userSettings: UserSettings;
  input: DigestComposeInput;
  storage: PluginStore;
  userStorage: PluginStore | null;
  now: () => Date;
}): Promise<string> {
  const { settings } = options;
  const plan = planOf(options.input, settings, options.userSettings);
  if (!plan)
    return "None of the test digest's articles are from feeds it reads, so it would add nothing.";
  const tokens = tokensIn(plan.planned);
  const left = await remaining(
    { instance: settings.monthlyTokens, user: settings.userMonthlyTokens },
    { instance: options.storage, user: options.userStorage },
    options.now(),
  );
  const formatted = (n: number) => new Intl.NumberFormat('en').format(n);
  const count = plan.entries.length;
  const articles = `${formatted(count)} ${count === 1 ? 'article' : 'articles'}`;
  const requests = `${String(plan.planned.length)} ${plan.planned.length === 1 ? 'request' : 'requests'}`;
  if (left < tokens)
    return `A test digest now: ${articles}, about ${formatted(tokens)} tokens, more than the ${formatted(left)} left of this month's budget, so it would add nothing.`;
  return `A test digest now: ${articles} in ${requests} to ${settings.model} at ${settings.effort} effort, about ${formatted(tokens)} tokens, ${dollars(costOf(settings.model, plan.planned))}. The output is estimated.`;
}

/** What a digest's overview ended as, and what it adds to the digest. */
export interface Composed {
  overview: string | null;
  sections: DigestSection[] | null;
  outcome: DigestOutcome;
}

const nothing = (outcome: DigestOutcome): Composed => ({ overview: null, sections: null, outcome });

/**
 * One digest's overview: the user's chosen entries of those listed and unlisted, read in one
 * request, or in parts whose themes a last request turns into the overview, within the budgets,
 * as a lead and sections whose points cite entries. Whatever a request ends as (refused,
 * unreadable, out of time), the digest goes out without it.
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
}): Promise<Composed> {
  const { client, settings, userSettings, input, storage, userStorage, logger, signal } = options;
  const plan = planOf(input, settings, userSettings);
  if (!plan) return nothing('none');
  const { entries, feeds, ids, preferences, total, parts, planned } = plan;
  const { names } = preferences;
  const budgets = { instance: settings.monthlyTokens, user: settings.userMonthlyTokens };
  if (
    (await remaining(budgets, { instance: storage, user: userStorage }, options.now())) <
    tokensIn(planned)
  )
    return nothing('over budget');

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
    system: readonly [string, string],
    prompt: string,
    format: OutputFormat,
    by: number,
  ): Promise<Asked> => {
    let response: Anthropic.Beta.BetaMessage;
    // Whole milliseconds: AbortSignal.timeout refuses fractions.
    const left = Math.max(1, Math.floor(by - Date.now()));
    const ownTime = AbortSignal.timeout(left);
    try {
      response = await client.beta.messages.create(
        {
          model: settings.model,
          max_tokens: MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort: settings.effort, format },
          // The fixed prompt first, cached for every reader's digests; then the reader's own.
          system: [
            { type: 'text', text: system[0], cache_control: { type: 'ephemeral' } },
            { type: 'text', text: system[1] },
          ],
          messages: [{ role: 'user', content: prompt }],
        },
        {
          signal: AbortSignal.any([signal, ownTime]),
          timeout: left,
          maxRetries: 0,
        },
      );
    } catch (error) {
      // Out of its own time, rather than the digest's (which ends the digest too).
      const timedOut =
        !signal.aborted &&
        (ownTime.aborted || error instanceof Anthropic.APIConnectionTimeoutError);
      logger.warn(timedOut ? 'digest request ran out of time' : 'digest request failed', {
        error: String(error),
      });
      return { ok: false, outcome: timedOut ? 'timed out' : 'failed' };
    }
    await counted(tokensOf(response.usage));
    if (response.stop_reason === 'refusal') return { ok: false, outcome: 'refused' };
    if (response.stop_reason !== 'end_turn') return { ok: false, outcome: 'invalid' };
    return { ok: true, text: finalText(response.content) };
  };

  const language = input.language;
  const frequency = input.frequency;
  const read = (text: string) => readSections(text, { names, length: userSettings.length, ids });
  if (!parts) {
    const asked = await ask(
      [OVERVIEW_SYSTEM, preferences.overview],
      overviewPrompt({ language, frequency, total, feeds }),
      sectionsFormat(names),
      options.deadline,
    );
    if (!asked.ok) return nothing(asked.outcome);
    const overview = read(asked.text);
    return overview
      ? { ...additionsOf(overview, userSettings), outcome: 'written' }
      : nothing('invalid');
  }

  const partsBy = Date.now() + Math.floor((options.deadline - Date.now()) * PARTS_SHARE);
  const found = await Promise.all(
    parts.map(async (part): Promise<PartThemes | DigestOutcome> => {
      const asked = await ask(
        [PART_SYSTEM, preferences.parts],
        partPrompt({ language, feeds: part }),
        partFormat(names),
        partsBy,
      );
      if (!asked.ok) return asked.outcome;
      return readPart(asked.text, { names, ids }) ?? 'invalid';
    }),
  );
  // A part that failed or ran out of time leaves the overview to the parts that answered.
  const answered = parts.filter((_, index) => typeof found[index] !== 'string');
  if (answered.length === 0) return nothing(found[0] as DigestOutcome);
  const asked = await ask(
    [MERGE_SYSTEM, preferences.overview],
    mergePrompt({
      language,
      frequency,
      given: entries.length,
      read: answered.length < parts.length ? articleCount(answered.flat()) : entries.length,
      total,
      parts: found.filter((part) => typeof part !== 'string'),
    }),
    sectionsFormat(names),
    options.deadline,
  );
  if (!asked.ok) return nothing(asked.outcome);
  const overview = read(asked.text);
  if (!overview) return nothing('invalid');
  const additions = additionsOf(overview, userSettings);
  if (answered.length === parts.length) return { ...additions, outcome: 'written' };
  const missed = found.filter((part) => typeof part === 'string');
  const note = missingNote({
    read: articleCount(answered.flat()),
    given: entries.length,
    parts: parts.length,
    timedOut: missed.filter((outcome) => outcome === 'timed out').length,
    failed: missed.filter((outcome) => outcome !== 'timed out').length,
  });
  return {
    overview: additions.overview ? withNote(additions.overview, note) : note,
    sections: additions.sections,
    outcome: 'partial',
  };
}

/** What an overview written from only some parts says of the rest. */
export function missingNote(counts: {
  read: number;
  given: number;
  parts: number;
  timedOut: number;
  failed: number;
}): string {
  const n = (count: number) => new Intl.NumberFormat('en').format(count);
  const { timedOut, failed } = counts;
  const why = [
    timedOut > 0 && `${n(timedOut)} ran out of time`,
    failed > 0 && `${n(failed)} failed`,
  ].filter(Boolean);
  return `This overview covers ${n(counts.read)} of ${n(counts.given)} articles: of the ${n(counts.parts)} parts they were read in, ${why.join(' and ')}.`;
}

/** The overview with a last paragraph, within the digest's limit. */
const withNote = (overview: string, note: string) =>
  `${overview.slice(0, DIGEST_LIMITS.overview - note.length - 2).trimEnd()}\n\n${note}`;

/** Articles in the feeds. */
const articleCount = (feeds: readonly FeedArticles[]) =>
  feeds.reduce((sum, feed) => sum + feed.articles.length, 0);

/** Tokens the articles take in a request, about. */
const articlesTokens = (feeds: readonly FeedArticles[]) =>
  feeds.reduce(
    (sum, feed) =>
      sum +
      estimateTokens(`<feed><name>${feed.feed}</name></feed>`) +
      feed.articles.reduce((n, article) => n + articleTokens(article), 0),
    0,
  );
