import { readFileSync } from 'node:fs';
import type { DigestComposeInput, DigestEntry } from '@newses/plugin-api';
import { fixtureDigestEntry, MemoryStore, runHook, runTest } from '@newses/plugin-api/testing';
import { describe, expect, it, vi } from 'vitest';
import { clientFor } from './claude.js';
import { compose, estimateTokens, PART_TOKENS, partsOf } from './digest.js';
import plugin from './index.js';
import {
  MERGE_SYSTEM,
  OVERVIEW_FORMAT,
  OVERVIEW_SYSTEM,
  PART_FORMAT,
  PART_SYSTEM,
} from './prompts.js';
import { instanceSettings, userSettings } from './settings.js';
import { FakeApi } from './test/fake-api.js';
import { answered, cutOff, fellBack, refused } from './test/responses.js';
import { monthOf } from './usage.js';

const SETTINGS = { apiKey: 'sk-ant-api03-test' };
const MONTH = `usage:${monthOf(new Date())}`;

const tech = { id: 4, title: 'Tech & Co', url: 'https://tech.example/feed', withLogin: false };
const weather = { id: 9, title: 'Weather', url: 'https://weather.example/feed', withLogin: false };
const members = { id: 2, title: 'Members', url: null, withLogin: true };

const article = (id: number, feed: DigestEntry['feed'], title = `Story ${String(id)}`) =>
  fixtureDigestEntry({
    id,
    title,
    feed,
    excerpt: `What ${title} says.`,
    contentHash: `h${String(id)}`,
  });

/** Everything one test shares: the fake API and the stores. */
function setup() {
  const api = new FakeApi();
  const storage = new MemoryStore();
  const userStorage = new MemoryStore();
  const run = (
    input: DigestComposeInput,
    options: { settings?: Record<string, unknown>; userSettings?: Record<string, unknown> } = {},
  ) =>
    runHook(plugin, 'digest.compose', input, {
      settings: { ...SETTINGS, ...options.settings },
      userSettings: options.userSettings ?? {},
      fetch: api.fetch,
      storage,
      userStorage,
    });
  return { api, storage, userStorage, run };
}

const digestOf = (
  entries: DigestEntry[],
  unlisted: DigestEntry[] = [],
  more = unlisted.length,
): DigestComposeInput => ({
  userId: 1,
  language: 'en',
  frequency: 'daily',
  entries,
  more,
  unlisted,
});

const userTurn = (body: Record<string, unknown> | undefined) =>
  (body?.messages as { content: string }[] | undefined)?.[0]?.content ?? '';
const systemOf = (body: Record<string, unknown> | undefined) =>
  (body?.system as { text: string }[] | undefined)?.[0]?.text;

const outcomeOf = (logs: readonly { message: string; fields?: Record<string, unknown> }[]) =>
  logs.find((line) => line.message === 'digest composed')?.fields?.outcome;

describe('digest summary plugin', () => {
  it('has the version package.json has, and hooks only the digest and the test', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.hosts).toEqual(['api.anthropic.com']);
    expect(Object.keys(plugin.hooks)).toEqual(['digest.compose', 'test']);
  });

  it('defaults to Opus 5.5 at low effort and budgets, and each user to all their feeds', () => {
    expect(instanceSettings.parse(SETTINGS)).toEqual({
      ...SETTINGS,
      model: 'claude-opus-5-5',
      effort: 'low',
      monthlyTokens: 10_000_000,
      userMonthlyTokens: 1_000_000,
    });
    expect(instanceSettings.safeParse({}).success).toBe(false);
    expect(userSettings.parse({})).toEqual({ feedChoice: 'all', feeds: [] });
  });
});

describe('digest.compose', () => {
  it('writes one overview from the listed and unlisted articles, by feed, counting its tokens', async () => {
    const { api, storage, userStorage, run } = setup();
    api.messages.push(
      answered({ overview: 'Chips everywhere.\n\nAlso: rain.' }, { input: 900, output: 300 }),
    );
    const { value, context } = await run(
      digestOf(
        [article(1, tech, 'New <chip>'), article(2, weather)],
        [article(3, tech), article(4, weather)],
        3,
      ),
    );
    expect(value).toEqual({ overview: 'Chips everywhere.\n\nAlso: rain.' });
    expect(outcomeOf(context.logs)).toBe('written');
    const [body] = api.messageBodies;
    expect(api.messageBodies).toHaveLength(1);
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      fallbacks: 'default',
      output_config: { effort: 'low', format: OVERVIEW_FORMAT },
    });
    expect(systemOf(body)).toBe(OVERVIEW_SYSTEM);
    expect(userTurn(body)).toBe(`Language: en
Write: an overview of this daily digest. The digest has 5 unread articles; these are the 4 newest.

<articles>
<feed>
<name>Tech &amp; Co</name>
<article><title>New &lt;chip&gt;</title><start>What New &lt;chip&gt; says.</start></article>
<article><title>Story 3</title><start>What Story 3 says.</start></article>
</feed>
<feed>
<name>Weather</name>
<article><title>Story 2</title><start>What Story 2 says.</start></article>
<article><title>Story 4</title><start>What Story 4 says.</start></article>
</feed>
</articles>`);
    expect(api.requests[0]?.headers.get('anthropic-beta')).toContain(
      'server-side-fallback-2026-07-01',
    );
    expect(await storage.get(MONTH)).toBe(1200);
    expect(await userStorage.get(MONTH)).toBe(1200);
  });

  it('says how many the digest has beyond the articles it was given', async () => {
    const { api, run } = setup();
    api.messages.push(answered({ overview: 'Quiet.' }, { input: 10, output: 10 }));
    await run(digestOf([article(1, tech)], [article(2, tech)], 50));
    expect(userTurn(api.messageBodies[0])).toContain(
      'The digest has 51 unread articles; these are the 2 newest.',
    );
  });

  it('reads only the feeds the user chose, or all but those', async () => {
    const digest = digestOf([article(1, tech), article(2, weather)]);
    const only = setup();
    only.api.messages.push(answered({ overview: 'Tech.' }, { input: 10, output: 10 }));
    await only.run(digest, { userSettings: { feedChoice: 'only', feeds: [tech.id] } });
    expect(userTurn(only.api.messageBodies[0])).toContain('Story 1');
    expect(userTurn(only.api.messageBodies[0])).not.toContain('Story 2');

    const except = setup();
    except.api.messages.push(answered({ overview: 'Rain.' }, { input: 10, output: 10 }));
    await except.run(digest, { userSettings: { feedChoice: 'except', feeds: [tech.id] } });
    expect(userTurn(except.api.messageBodies[0])).not.toContain('Story 1');
    expect(userTurn(except.api.messageBodies[0])).toContain('Story 2');

    const none = setup();
    const { value, context } = await none.run(digest, {
      userSettings: { feedChoice: 'only', feeds: [] },
    });
    expect(value).toEqual({ overview: null });
    expect(none.api.requests).toEqual([]);
    expect(outcomeOf(context.logs)).toBe('none');
  });

  it('never sends articles of feeds with a login, or pages', async () => {
    const { api, run } = setup();
    const page = fixtureDigestEntry({ id: 7, title: 'My page', feed: null });
    const { value } = await run(digestOf([article(5, members, 'Secret plans'), page]));
    expect(value).toEqual({ overview: null });
    expect(api.requests).toEqual([]);

    api.messages.push(answered({ overview: 'Tech.' }, { input: 10, output: 10 }));
    await run(digestOf([article(5, members, 'Secret plans'), page, article(6, tech)]));
    const turn = userTurn(api.messageBodies[0]);
    expect(turn).toContain('Story 6');
    expect(turn).not.toContain('Secret plans');
    expect(turn).not.toContain('My page');
  });

  it('reads the fallback model’s answer after a refusal, counting both attempts', async () => {
    const { api, storage, run } = setup();
    api.messages.push(fellBack({ overview: 'Fallen back.' }));
    const { value } = await run(digestOf([article(1, tech)]));
    expect(value).toEqual({ overview: 'Fallen back.' });
    expect(await storage.get(MONTH)).toBe(900 + 950 + 120);
  });

  it('adds nothing when the answer is refused, cut off, or not the format asked for', async () => {
    for (const [answer, outcome] of [
      [refused, 'refused'],
      [cutOff, 'invalid'],
      [answered({ summary: 'wrong shape' }, { input: 10, output: 10 }), 'invalid'],
      [answered({ overview: '  ' }, { input: 10, output: 10 }), 'invalid'],
      [{ status: 500, error: 'api_error' }, 'failed'],
    ] as const) {
      const { api, run } = setup();
      api.messages.push(answer);
      const { value, context } = await run(digestOf([article(1, tech)]));
      expect([outcome, value]).toEqual([outcome, { overview: null }]);
      expect(outcomeOf(context.logs)).toBe(outcome);
    }
  });

  it('adds nothing when the API does not answer in time', async () => {
    const { api, storage, userStorage } = setup();
    api.messages.push('hang');
    const started = Date.now();
    const result = await compose({
      client: clientFor(SETTINGS, api.fetch),
      settings: instanceSettings.parse(SETTINGS),
      userSettings: userSettings.parse({}),
      input: digestOf([article(1, tech)]),
      storage,
      userStorage,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      signal: new AbortController().signal,
      deadline: Date.now() + 50,
      now: () => new Date(),
    });
    expect(result).toEqual({ overview: null, outcome: 'failed' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('makes no request past either budget', async () => {
    const { api, storage, userStorage, run } = setup();
    await userStorage.set(MONTH, 999_000);
    const { value, context } = await run(digestOf([article(1, tech)]));
    expect(value).toEqual({ overview: null });
    expect(outcomeOf(context.logs)).toBe('over budget');
    await userStorage.delete(MONTH);
    await storage.set(MONTH, 10_000_000);
    await run(digestOf([article(1, tech)]));
    expect(api.requests).toEqual([]);
  });
});

describe('large digests', () => {
  /** A feed's articles with long excerpts, so many of them take more than one request. */
  const many = (feed: DigestEntry['feed'], from: number, count: number) =>
    Array.from({ length: count }, (_, i) =>
      fixtureDigestEntry({
        id: from + i,
        title: `Report ${String(from + i)}`,
        feed,
        excerpt: 'x'.repeat(600),
      }),
    );

  it('packs feeds into parts, splitting only a feed larger than a part', () => {
    const feeds = [
      {
        feed: 'A',
        articles: Array.from({ length: 3 }, () => ({ title: 'a', excerpt: 'x'.repeat(300) })),
      },
      {
        feed: 'B',
        articles: Array.from({ length: 2 }, () => ({ title: 'b', excerpt: 'x'.repeat(300) })),
      },
      {
        feed: 'C',
        articles: Array.from({ length: 7 }, () => ({ title: 'c', excerpt: 'x'.repeat(300) })),
      },
    ];
    const size = estimateTokens(`<article><title>a</title><start>${'x'.repeat(300)}</start>`);
    const parts = partsOf(feeds, size * 5);
    expect(parts.map((part) => part.map((piece) => [piece.feed, piece.articles.length]))).toEqual([
      [
        ['A', 3],
        ['B', 2],
      ],
      [['C', 5]],
      [['C', 2]],
    ]);
  });

  it('reads a digest too large for one request in parts, then writes the overview from their themes', async () => {
    const { api, storage, run } = setup();
    const entries = [...many(tech, 1, 150), ...many(weather, 1001, 150)];
    const whole = entries.length * estimateTokens('x'.repeat(640));
    expect(whole).toBeGreaterThan(PART_TOKENS);
    api.messages.push(
      answered(
        { themes: [{ theme: 'Chips <b>', articles: 120 }], notable: ['A merger.'] },
        { input: 40_000, output: 500 },
      ),
      answered(
        { themes: [{ theme: 'Storms', articles: 90 }], notable: [] },
        { input: 40_000, output: 500 },
      ),
      answered({ overview: 'Chips and storms.' }, { input: 1_000, output: 300 }),
    );
    const { value } = await run(digestOf(entries.slice(0, 100), entries.slice(100)));
    expect(value).toEqual({ overview: 'Chips and storms.' });
    const bodies = api.messageBodies;
    expect(bodies.map(systemOf)).toEqual([PART_SYSTEM, PART_SYSTEM, MERGE_SYSTEM]);
    expect(bodies[0]?.output_config).toEqual({ effort: 'low', format: PART_FORMAT });
    expect(bodies[2]?.output_config).toEqual({ effort: 'low', format: OVERVIEW_FORMAT });
    expect(userTurn(bodies[0])).toContain('Report 1<');
    expect(userTurn(bodies[1])).toContain('Report 1150<');
    expect(userTurn(bodies[2])).toBe(`Language: en
Write: an overview of this daily digest. The digest has 300 unread articles.

<parts>
<part number="1">
<theme articles="120">Chips &lt;b&gt;</theme>
<notable>A merger.</notable>
</part>
<part number="2">
<theme articles="90">Storms</theme>
</part>
</parts>`);
    expect(await storage.get(MONTH)).toBe(40_500 + 40_500 + 1_300);
  });

  it('reads the parts when time has passed since the digest started', async () => {
    // Each reading of the clock a millisecond on, so the parts' share of the time left is not whole.
    const TOKENS = { input: 10, output: 10 };
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1));
    try {
      const { api, run } = setup();
      const entries = [...many(tech, 1, 150), ...many(weather, 1001, 150)];
      api.messages.push(
        answered({ themes: [{ theme: 'Chips', articles: 150 }], notable: [] }, TOKENS),
        answered({ themes: [{ theme: 'Storms', articles: 150 }], notable: [] }, TOKENS),
        answered({ overview: 'Chips and storms.' }, TOKENS),
      );
      const { value } = await run(digestOf(entries.slice(0, 100), entries.slice(100)));
      expect(value).toEqual({ overview: 'Chips and storms.' });
    } finally {
      clock.mockRestore();
    }
  });

  it('adds nothing when a part fails, without asking for the overview', async () => {
    const { api, run } = setup();
    const entries = [...many(tech, 1, 150), ...many(weather, 1001, 150)];
    api.messages.push(answered({ themes: [], notable: [] }, { input: 10, output: 10 }), {
      status: 529,
      error: 'overloaded_error',
    });
    const { value, context } = await run(digestOf(entries));
    expect(value).toEqual({ overview: null });
    expect(outcomeOf(context.logs)).toBe('failed');
    expect(api.messageBodies).toHaveLength(2);
  });

  it('adds nothing when the overview from the parts is refused', async () => {
    const { api, run } = setup();
    const entries = [...many(tech, 1, 150), ...many(weather, 1001, 150)];
    api.messages.push(
      answered(
        { themes: [{ theme: 'Chips', articles: 3 }], notable: [] },
        { input: 10, output: 10 },
      ),
      answered(
        { themes: [{ theme: 'Rain', articles: 3 }], notable: [] },
        { input: 10, output: 10 },
      ),
      refused,
    );
    const { value, context } = await run(digestOf(entries));
    expect(value).toEqual({ overview: null });
    expect(outcomeOf(context.logs)).toBe('refused');
  });
});

describe('test', () => {
  it('checks the key with the model, and says what this month used', async () => {
    const { api, storage, userStorage } = setup();
    await storage.set(MONTH, 1_234_567);
    await userStorage.set(MONTH, 4_321);
    const options = { settings: SETTINGS, fetch: api.fetch, storage, userStorage };
    const { value } = await runTest(plugin, options);
    expect(value).toEqual({
      ok: true,
      message:
        "The API key works with claude-opus-5-5. Tokens this month: yours 4,321 of 1,000,000, the server's 1,234,567 of 10,000,000.",
    });
    expect(api.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models/claude-opus-5-5' });
    expect(api.requests[0]?.headers.get('authorization')).toBe('Bearer sk-ant-api03-test');

    api.modelStatus = 401;
    const failed = await runTest(plugin, options);
    expect(failed.value).toEqual({
      ok: false,
      message: 'The API key was refused (HTTP 401): check it in the server’s settings',
    });
  });
});
