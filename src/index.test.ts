import { readFileSync } from 'node:fs';
import type { DigestComposeInput, DigestEntry } from '@newses/plugin-api';
import {
  fixtureDigestEntry,
  MemoryStore,
  runAction,
  runHook,
  runTest,
} from '@newses/plugin-api/testing';
import { describe, expect, it, vi } from 'vitest';
import { clientFor } from './claude.js';
import { compose, estimateTokens, PART_TOKENS, partsOf, planOf } from './digest.js';
import plugin from './index.js';
import {
  MERGE_SYSTEM,
  OVERVIEW_SYSTEM,
  PART_SYSTEM,
  partFormat,
  sectionsFormat,
} from './prompts.js';
import { costOf, dollars, tokensIn } from './prices.js';
import { DEFAULT_SECTIONS, instanceSettings, userSettings } from './settings.js';
import { FakeApi } from './test/fake-api.js';
import { answered, cutOff, fellBack, refused } from './test/responses.js';
import { monthOf } from './usage.js';

const SETTINGS = { apiKey: 'sk-ant-api03-test' };
const MONTH = `usage:${monthOf(new Date())}`;

const tech = { id: 4, title: 'Tech & Co', url: 'https://tech.example/feed', withLogin: false };
const weather = { id: 9, title: 'Weather', url: 'https://weather.example/feed', withLogin: false };
const members = { id: 2, title: 'Members', url: null, withLogin: true };
const sport = { id: 11, title: 'Sport', url: 'https://sport.example/feed', withLogin: false };

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
/** The reader's preferences: the second system block. */
const preferencesOf = (body: Record<string, unknown> | undefined) =>
  (body?.system as { text: string }[] | undefined)?.[1]?.text ?? '';

const NAMES = DEFAULT_SECTIONS.map((section) => section.name);
const NOTHING = { overview: null, sections: null };

/** An overview's answer: a lead, and sections of points citing refs, headed by their names. */
const overviewAnswer = (
  lead: string,
  sections: {
    section: string;
    heading?: string;
    points: { text: string; refs: string[] }[];
  }[] = [],
) => ({ lead, sections: sections.map((section) => ({ heading: section.section, ...section })) });

/** One part's answer: themes by section. */
const partAnswer = (
  sections: { section: string; themes: { theme: string; articles: number; refs: string[] }[] }[],
) => ({ sections });

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
    expect(Object.keys(plugin.actions ?? {})).toEqual(['estimate']);
  });

  it('defaults to Opus 5.5 at low effort and budgets, and each user to all their feeds in the default sections', () => {
    expect(instanceSettings.parse(SETTINGS)).toEqual({
      ...SETTINGS,
      model: 'claude-opus-5-5',
      effort: 'low',
      monthlyTokens: 10_000_000,
      userMonthlyTokens: 1_000_000,
      allowInstructions: true,
    });
    expect(instanceSettings.safeParse({}).success).toBe(false);
    expect(userSettings.parse({})).toEqual({
      feedChoice: 'all',
      feeds: [],
      sections: DEFAULT_SECTIONS,
      length: 'standard',
      style: 'paragraphs',
      lead: true,
      instructions: '',
    });
    expect(userSettings.safeParse({ instructions: 'x'.repeat(1001) }).success).toBe(false);
    expect(userSettings.safeParse({ sections: [{ name: ' ' }] }).success).toBe(false);
  });
});

describe('digest.compose', () => {
  it('writes one overview from the listed and unlisted articles, by feed, counting its tokens', async () => {
    const { api, storage, userStorage, run } = setup();
    api.messages.push(
      answered(
        overviewAnswer('Chips everywhere.\n\nAlso: rain.', [
          { section: 'Science', points: [{ text: 'Rain.', refs: ['a2'] }] },
          {
            section: 'Technology',
            points: [{ text: 'New chips.', refs: ['a1', 'a3', 'a1', 'a99', ' a3 '] }],
          },
        ]),
        { input: 900, output: 300 },
      ),
    );
    const { value, context } = await run(
      digestOf(
        [article(1, tech, 'New <chip>'), article(2, weather)],
        [article(3, tech), article(4, weather)],
        3,
      ),
    );
    // Sections in the reader's order, citing the entries the refs name, once each.
    expect(value).toEqual({
      overview: 'Chips everywhere.\n\nAlso: rain.',
      sections: [
        { heading: 'Technology', list: false, items: [{ text: 'New chips.', entries: [1, 3] }] },
        { heading: 'Science', list: false, items: [{ text: 'Rain.', entries: [2] }] },
      ],
    });
    expect(outcomeOf(context.logs)).toBe('written');
    const [body] = api.messageBodies;
    expect(api.messageBodies).toHaveLength(1);
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      fallbacks: 'default',
      output_config: { effort: 'low', format: sectionsFormat(NAMES) },
    });
    expect(systemOf(body)).toBe(OVERVIEW_SYSTEM);
    expect((body?.system as { cache_control?: unknown }[]).map((b) => b.cache_control)).toEqual([
      { type: 'ephemeral' },
      undefined,
    ]);
    expect(preferencesOf(body)).toContain(
      '<section name="World">International news, conflicts, and diplomacy</section>',
    );
    expect(preferencesOf(body)).not.toContain('<instructions>');
    expect(userTurn(body)).toBe(`Language: en
Write: an overview of this daily digest. The digest has 5 unread articles; these are the 4 newest.

<articles>
<feed>
<name>Tech &amp; Co</name>
<article ref="a1"><title>New &lt;chip&gt;</title><start>What New &lt;chip&gt; says.</start></article>
<article ref="a3"><title>Story 3</title><start>What Story 3 says.</start></article>
</feed>
<feed>
<name>Weather</name>
<article ref="a2"><title>Story 2</title><start>What Story 2 says.</start></article>
<article ref="a4"><title>Story 4</title><start>What Story 4 says.</start></article>
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
    api.messages.push(answered(overviewAnswer('Quiet.'), { input: 10, output: 10 }));
    await run(digestOf([article(1, tech)], [article(2, tech)], 50));
    expect(userTurn(api.messageBodies[0])).toContain(
      'The digest has 51 unread articles; these are the 2 newest.',
    );
  });

  it("gives the reader's sections, length, lead, and instructions, and follows them", async () => {
    const { api, run } = setup();
    const answer = overviewAnswer('A lead nobody asked for.', [
      {
        section: 'AI & chips',
        heading: 'IA y\nchips',
        points: ['One', 'Two', 'Three'].map((text) => ({ text, refs: ['a1'] })),
      },
      { section: 'Other', points: [] },
    ]);
    api.messages.push(answered(answer, { input: 10, output: 10 }));
    const reader = {
      sections: [
        { name: 'AI & chips', about: 'Models, GPUs' },
        { name: 'ai & CHIPS' },
        { name: 'Other' },
      ],
      length: 'brief',
      style: 'bullets',
      lead: false,
      instructions: '  Skip <celebrity> news.  ',
    };
    const { value } = await run(digestOf([article(1, tech)]), { userSettings: reader });
    const [body] = api.messageBodies;
    expect(preferencesOf(body)).toBe(`<reader_preferences>
<sections>
<section name="AI &amp; chips">Models, GPUs</section>
<section name="Other"></section>
</sections>
<length>At most 2 points a section, each at most 30 words.</length>
<lead>No lead: leave it empty.</lead>
<instructions>
Skip &lt;celebrity&gt; news.
</instructions>
</reader_preferences>`);
    expect(body?.output_config).toEqual({
      effort: 'low',
      format: sectionsFormat(['AI & chips', 'Other']),
    });
    // No lead, bullets, the brief length's 2 points, and the heading on one line.
    expect(value).toEqual({
      overview: null,
      sections: [
        {
          heading: 'IA y chips',
          list: true,
          items: [
            { text: 'One', entries: [1] },
            { text: 'Two', entries: [1] },
          ],
        },
      ],
    });

    // Instructions are left out when the server does not allow them.
    api.messages.push(answered(answer, { input: 10, output: 10 }));
    await run(digestOf([article(1, tech)]), {
      settings: { allowInstructions: false },
      userSettings: reader,
    });
    expect(preferencesOf(api.messageBodies[1])).not.toContain('celebrity');
  });

  it('keeps sections within the digest’s limits, leaving out what it does not take', async () => {
    const { api, run } = setup();
    const names = Array.from({ length: 12 }, (_, i) => `S${String(i + 1)}`);
    const refs = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
    api.messages.push(
      answered(
        overviewAnswer('', [
          { section: 'Unknown', points: [{ text: 'Made up', refs }] },
          { section: 'S2', heading: '  ', points: [{ text: 'Second', refs }] },
          ...names.map((section) => ({
            section,
            points: Array.from({ length: 3 }, () => ({ text: 'x'.repeat(700), refs: ['a1'] })),
          })),
        ]),
        { input: 10, output: 10 },
      ),
    );
    const entries = Array.from({ length: 7 }, (_, i) => article(i + 1, tech));
    const { value } = await run(digestOf(entries), {
      userSettings: { sections: names.map((name) => ({ name })) },
    });
    const sections = value?.sections ?? [];
    // A section named twice is joined, its heading its name when the answer gave none.
    expect(sections[1]?.heading).toBe('S2');
    expect(sections[1]?.items[0]).toEqual({ text: 'Second', entries: [1, 2, 3, 4, 5] });
    expect(sections[0]?.items[0]?.text).toHaveLength(600);
    expect(sections.map((section) => section.items.length)).toEqual([3, 3, 3, 3, 2]);
    expect(value?.overview).toBeNull();
  });

  it('reads only the feeds the user chose, or all but those', async () => {
    const digest = digestOf([article(1, tech), article(2, weather)]);
    const only = setup();
    only.api.messages.push(answered(overviewAnswer('Tech.'), { input: 10, output: 10 }));
    await only.run(digest, { userSettings: { feedChoice: 'only', feeds: [tech.id] } });
    expect(userTurn(only.api.messageBodies[0])).toContain('Story 1');
    expect(userTurn(only.api.messageBodies[0])).not.toContain('Story 2');

    const except = setup();
    except.api.messages.push(answered(overviewAnswer('Rain.'), { input: 10, output: 10 }));
    await except.run(digest, { userSettings: { feedChoice: 'except', feeds: [tech.id] } });
    expect(userTurn(except.api.messageBodies[0])).not.toContain('Story 1');
    expect(userTurn(except.api.messageBodies[0])).toContain('Story 2');

    const none = setup();
    const { value, context } = await none.run(digest, {
      userSettings: { feedChoice: 'only', feeds: [] },
    });
    expect(value).toEqual(NOTHING);
    expect(none.api.requests).toEqual([]);
    expect(outcomeOf(context.logs)).toBe('none');
  });

  it('never sends articles of feeds with a login, or pages', async () => {
    const { api, run } = setup();
    const page = fixtureDigestEntry({ id: 7, title: 'My page', feed: null });
    const { value } = await run(digestOf([article(5, members, 'Secret plans'), page]));
    expect(value).toEqual(NOTHING);
    expect(api.requests).toEqual([]);

    api.messages.push(answered(overviewAnswer('Tech.'), { input: 10, output: 10 }));
    await run(digestOf([article(5, members, 'Secret plans'), page, article(6, tech)]));
    const turn = userTurn(api.messageBodies[0]);
    expect(turn).toContain('Story 6');
    expect(turn).not.toContain('Secret plans');
    expect(turn).not.toContain('My page');
  });

  it('reads the fallback model’s answer after a refusal, counting both attempts', async () => {
    const { api, storage, run } = setup();
    api.messages.push(fellBack(overviewAnswer('Fallen back.')));
    const { value } = await run(digestOf([article(1, tech)]));
    expect(value).toEqual({ overview: 'Fallen back.', sections: [] });
    expect(await storage.get(MONTH)).toBe(900 + 950 + 120);
  });

  it('adds nothing when the answer is refused, cut off, or not the format asked for', async () => {
    for (const [answer, outcome] of [
      [refused, 'refused'],
      [cutOff, 'invalid'],
      [answered({ overview: 'the old shape' }, { input: 10, output: 10 }), 'invalid'],
      [answered(overviewAnswer('  '), { input: 10, output: 10 }), 'invalid'],
      [
        answered(overviewAnswer('', [{ section: 'World', points: [{ text: ' ', refs: [] }] }]), {
          input: 10,
          output: 10,
        }),
        'invalid',
      ],
      [{ status: 500, error: 'api_error' }, 'failed'],
    ] as const) {
      const { api, run } = setup();
      api.messages.push(answer);
      const { value, context } = await run(digestOf([article(1, tech)]));
      expect([outcome, value]).toEqual([outcome, NOTHING]);
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
    expect(result).toEqual({ ...NOTHING, outcome: 'timed out' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('makes no request past either budget', async () => {
    const { api, storage, userStorage, run } = setup();
    await userStorage.set(MONTH, 999_000);
    const { value, context } = await run(digestOf([article(1, tech)]));
    expect(value).toEqual(NOTHING);
    expect(outcomeOf(context.logs)).toBe('over budget');
    await userStorage.delete(MONTH);
    await storage.set(MONTH, 10_000_000);
    await run(digestOf([article(1, tech)]));
    expect(api.requests).toEqual([]);
  });
});

/** A feed's articles with long excerpts, so many of them take more than one request. */
const many = (feed: DigestEntry['feed'], from: number, count: number) =>
  Array.from({ length: count }, (_, i) =>
    fixtureDigestEntry({
      id: from + i,
      title: `Report ${String(from + i)}`,
      feed,
      excerpt: 'x'.repeat(1300),
    }),
  );

/** A part's answer, the overview's points, and its sections, of the tech feed's first report. */
const chipsPart = partAnswer([
  { section: 'Technology', themes: [{ theme: 'Chips', articles: 150, refs: ['a1'] }] },
]);
const chipsPoints = [{ section: 'Technology', points: [{ text: 'Chips.', refs: ['a1'] }] }];
const chipsSections = [
  { heading: 'Technology', list: false, items: [{ text: 'Chips.', entries: [1] }] },
];

describe('large digests', () => {
  it('packs feeds into parts, splitting only a feed larger than a part', () => {
    const feeds = [
      {
        feed: 'A',
        articles: Array.from({ length: 3 }, () => ({
          ref: 'a1',
          title: 'a',
          excerpt: 'x'.repeat(300),
        })),
      },
      {
        feed: 'B',
        articles: Array.from({ length: 2 }, () => ({
          ref: 'a1',
          title: 'b',
          excerpt: 'x'.repeat(300),
        })),
      },
      {
        feed: 'C',
        articles: Array.from({ length: 7 }, () => ({
          ref: 'a1',
          title: 'c',
          excerpt: 'x'.repeat(300),
        })),
      },
    ];
    const size = estimateTokens(
      `<article ref="a1"><title>a</title><start>${'x'.repeat(300)}</start>`,
    );
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
    const whole = entries.length * estimateTokens('x'.repeat(1340));
    expect(whole).toBeGreaterThan(PART_TOKENS);
    api.messages.push(
      answered(
        partAnswer([
          {
            section: 'Technology',
            themes: [{ theme: 'Chips <b>', articles: 120, refs: ['a1', 'a2', 'a1', 'a999'] }],
          },
          { section: 'Unknown', themes: [{ theme: 'Made up', articles: 1, refs: ['a3'] }] },
        ]),
        { input: 40_000, output: 500 },
      ),
      answered(
        partAnswer([
          { section: 'Science', themes: [{ theme: 'Storms', articles: 90, refs: ['a151'] }] },
        ]),
        { input: 40_000, output: 500 },
      ),
      answered(
        overviewAnswer('Chips and storms.', [
          { section: 'Technology', points: [{ text: 'Chips.', refs: ['a1', 'a2'] }] },
          { section: 'Science', points: [{ text: 'Storms.', refs: ['a151'] }] },
        ]),
        { input: 1_000, output: 300 },
      ),
    );
    const { value } = await run(digestOf(entries.slice(0, 100), entries.slice(100)));
    expect(value).toEqual({
      overview: 'Chips and storms.',
      sections: [
        { heading: 'Technology', list: false, items: [{ text: 'Chips.', entries: [1, 2] }] },
        { heading: 'Science', list: false, items: [{ text: 'Storms.', entries: [1001] }] },
      ],
    });
    const bodies = api.messageBodies;
    expect(bodies.map(systemOf)).toEqual([PART_SYSTEM, PART_SYSTEM, MERGE_SYSTEM]);
    expect(bodies[0]?.output_config).toEqual({ effort: 'low', format: partFormat(NAMES) });
    expect(bodies[2]?.output_config).toEqual({ effort: 'low', format: sectionsFormat(NAMES) });
    // The parts get the sections, not the overview's length or lead.
    expect(preferencesOf(bodies[0])).toContain('<section name="World">');
    expect(preferencesOf(bodies[0])).not.toContain('<length>');
    expect(preferencesOf(bodies[2])).toContain('<length>');
    expect(userTurn(bodies[0])).toContain('<article ref="a1"><title>Report 1<');
    expect(userTurn(bodies[1])).toContain('<article ref="a300"><title>Report 1150<');
    expect(userTurn(bodies[2])).toBe(`Language: en
Write: an overview of this daily digest. The digest has 300 unread articles.

<parts>
<part number="1">
<section name="Technology">
<theme articles="120" refs="a1 a2">Chips &lt;b&gt;</theme>
</section>
</part>
<part number="2">
<section name="Science">
<theme articles="90" refs="a151">Storms</theme>
</section>
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
        answered(chipsPart, TOKENS),
        answered(
          partAnswer([
            { section: 'Science', themes: [{ theme: 'Storms', articles: 150, refs: ['a151'] }] },
          ]),
          TOKENS,
        ),
        answered(overviewAnswer('Chips and storms.'), TOKENS),
      );
      const { value } = await run(digestOf(entries.slice(0, 100), entries.slice(100)));
      expect(value).toEqual({ overview: 'Chips and storms.', sections: [] });
    } finally {
      clock.mockRestore();
    }
  });

  it('writes the overview from the parts that answered when one fails', async () => {
    const TOKENS = { input: 10, output: 10 };
    const { api, run } = setup();
    const entries = [...many(tech, 1, 150), ...many(weather, 1001, 150)];
    api.messages.push(
      answered(chipsPart, TOKENS),
      { status: 529, error: 'overloaded_error' },
      answered(overviewAnswer('Chips.', chipsPoints), TOKENS),
    );
    const { value, context } = await run(digestOf(entries));
    expect(value).toEqual({
      overview:
        'Chips.\n\nThis overview covers 150 of 300 articles: of the 2 parts they were read in, 1 failed.',
      sections: chipsSections,
    });
    expect(outcomeOf(context.logs)).toBe('partial');
    expect(userTurn(api.messageBodies[2])).toBe(`Language: en
Write: an overview of this daily digest. The digest has 300 unread articles; these themes are from 150 of them.

<parts>
<part number="1">
<section name="Technology">
<theme articles="150" refs="a1">Chips</theme>
</section>
</part>
</parts>`);
  });

  it('says what is missing without a lead when the reader has none', async () => {
    const TOKENS = { input: 10, output: 10 };
    const { api, run } = setup();
    const entries = [...many(tech, 1, 150), ...many(weather, 1001, 150)];
    api.messages.push(
      answered(chipsPart, TOKENS),
      { status: 529, error: 'overloaded_error' },
      answered(overviewAnswer('Lead', chipsPoints), TOKENS),
    );
    const { value } = await run(digestOf(entries), { userSettings: { lead: false } });
    expect(value?.overview).toMatch(/^This overview covers 150 of 300 articles/);
    expect(value?.sections).toEqual(chipsSections);
  });

  it('says which parts ran out of time and which failed', async () => {
    const TOKENS = { input: 10, output: 10 };
    const { api, storage, userStorage } = setup();
    const entries = [...many(tech, 1, 150), ...many(weather, 1001, 150), ...many(sport, 2001, 150)];
    api.messages.push(
      answered(chipsPart, TOKENS),
      'hang',
      { status: 529, error: 'overloaded_error' },
      answered(overviewAnswer('Chips.', chipsPoints), TOKENS),
    );
    const result = await compose({
      client: clientFor(SETTINGS, api.fetch),
      settings: instanceSettings.parse(SETTINGS),
      userSettings: userSettings.parse({}),
      input: digestOf(entries),
      storage,
      userStorage,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      signal: new AbortController().signal,
      deadline: Date.now() + 500,
      now: () => new Date(),
    });
    expect(result).toEqual({
      overview:
        'Chips.\n\nThis overview covers 150 of 450 articles: of the 3 parts they were read in, 1 ran out of time and 1 failed.',
      sections: chipsSections,
      outcome: 'partial',
    });
  });

  it('adds nothing when every part fails, without asking for the overview', async () => {
    const { api, run } = setup();
    const entries = [...many(tech, 1, 150), ...many(weather, 1001, 150)];
    api.messages.push(
      { status: 529, error: 'overloaded_error' },
      { status: 529, error: 'overloaded_error' },
    );
    const { value, context } = await run(digestOf(entries));
    expect(value).toEqual(NOTHING);
    expect(outcomeOf(context.logs)).toBe('failed');
    expect(api.messageBodies).toHaveLength(2);
  });

  it('adds nothing when the overview from the parts is refused', async () => {
    const { api, run } = setup();
    const entries = [...many(tech, 1, 150), ...many(weather, 1001, 150)];
    api.messages.push(
      answered(chipsPart, { input: 10, output: 10 }),
      answered(chipsPart, { input: 10, output: 10 }),
      refused,
    );
    const { value, context } = await run(digestOf(entries));
    expect(value).toEqual(NOTHING);
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

describe('estimate cost', () => {
  const estimateOf = (
    setup_: ReturnType<typeof setup>,
    digest: DigestComposeInput,
    options: { settings?: Record<string, unknown>; userSettings?: Record<string, unknown> } = {},
  ) =>
    runAction(plugin, 'estimate', {
      settings: { ...SETTINGS, ...options.settings },
      userSettings: options.userSettings ?? {},
      fetch: setup_.api.fetch,
      storage: setup_.storage,
      userStorage: setup_.userStorage,
      digest,
    });

  it('prices what the overview of a test digest would read, making no request', async () => {
    const context = setup();
    const entries = [...many(tech, 1, 150), ...many(weather, 1001, 150)];
    const digest = digestOf(entries.slice(0, 100), entries.slice(100));
    const { value } = await estimateOf(context, digest);
    expect(context.api.requests).toEqual([]);
    expect(value.ok).toBe(true);
    // Opus: $4 per million input, $20 per million output; 3,000 output a part, 5,000 the overview.
    const planned =
      planOf(digest, instanceSettings.parse(SETTINGS), userSettings.parse({}))?.planned ?? [];
    expect(planned).toHaveLength(3);
    expect(value.message).toBe(
      `A test digest now: 300 articles in 3 requests to claude-opus-5-5 at low effort, about ${new Intl.NumberFormat('en').format(tokensIn(planned))} tokens, ${dollars(costOf('claude-opus-5-5', planned))}. The output is estimated.`,
    );
    const haiku = await estimateOf(context, digest, { settings: { model: 'claude-haiku-5-5' } });
    expect(haiku.value.message).toContain('to claude-haiku-5-5 at low effort');
    expect(haiku.value.message).toMatch(/about \$0\.0\d\./);
  });

  it('reads only the chosen feeds, and says when it would add nothing', async () => {
    const context = setup();
    const digest = digestOf([article(1, tech), article(2, weather), article(3, members)]);
    const only = await estimateOf(context, digest, {
      userSettings: { feedChoice: 'only', feeds: [9] },
    });
    expect(only.value.message).toContain('A test digest now: 1 article in 1 request');
    expect(only.value.message).toContain('tokens, about $0.10.');
    const none = await estimateOf(context, digest, {
      userSettings: { feedChoice: 'only', feeds: [77] },
    });
    expect(none.value).toEqual({
      ok: true,
      message:
        "None of the test digest's articles are from feeds it reads, so it would add nothing.",
    });
    await context.userStorage.set(MONTH, 999_990);
    const over = await estimateOf(context, digest);
    expect(over.value.message).toMatch(
      /^A test digest now: 2 articles, about [\d,]+ tokens, more than the 10 left of this month's budget, so it would add nothing\.$/,
    );
  });
});

describe('prices', () => {
  it('prices input, cache writes and reads, and output', () => {
    const million = { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 };
    expect(costOf('claude-opus-5-5', [million])).toBe(4);
    expect(costOf('claude-opus-5-5', [{ ...million, input: 0, cacheWrite: 1_000_000 }])).toBe(5);
    expect(costOf('claude-sonnet-5-5', [{ ...million, input: 0, cacheRead: 1_000_000 }])).toBe(0.1);
    expect(costOf('claude-sonnet-5-5', [{ ...million, input: 0, output: 1_000_000 }])).toBe(10);
    // Haiku's prompt price by each request's prompt.
    const part = { input: 100_000, cacheWrite: 0, cacheRead: 0, output: 0 };
    expect(costOf('claude-haiku-5-5', [part, part])).toBeCloseTo(0.02);
    expect(costOf('claude-haiku-5-5', [{ ...part, input: 100_001 }])).toBeCloseTo(0.05);
    expect([dollars(0.953), dollars(0.004)]).toEqual(['about $0.95', 'less than $0.01']);
  });
});
