// Writes digest overviews with the Anthropic API at each effort, to choose the `effort` setting:
// the tokens each used, how long it took, and what it wrote: the lead, then each section's points
// with the titles of the articles they cite. Every run is billed to the key.
//
//   npm run build && ANTHROPIC_API_KEY=sk-ant-... node scripts/measure-effort.mjs [DIGEST.json ...]
//     [--efforts low,medium,high] [--model claude-opus-5-5] [--copies N]
//     [--length brief|standard|detailed] [--instructions TEXT]
//
// A digest file is what `digest.compose` is given (see scripts/sample-digest.json, the default).
// `--copies N` adds N copies of its articles as unlisted ones, to measure a digest large enough
// to be read in parts. `--length` and `--instructions` are a user's settings; the default sections
// are used. Each run has the 5 minutes a digest gives a plugin, less the plugin's margin.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DIGEST_LIMITS } from '@newses/plugin-api';
import { MemoryStore } from '@newses/plugin-api/testing';
import { clientFor } from '../dist/claude.js';
import { compose } from '../dist/digest.js';
import { EFFORTS, instanceSettings, MODELS, userSettings } from '../dist/settings.js';
import { usedThisMonth } from '../dist/usage.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    efforts: { type: 'string', default: EFFORTS.join(',') },
    model: { type: 'string', default: MODELS[0] },
    copies: { type: 'string', default: '0' },
    length: { type: 'string', default: 'standard' },
    instructions: { type: 'string', default: '' },
  },
});
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY to a key from the Claude Console');
const files = positionals.length
  ? positionals
  : [new URL('sample-digest.json', import.meta.url).pathname];
const copies = Number(values.copies);
const reader = userSettings.parse({ length: values.length, instructions: values.instructions });

/** The digest with `copies` more of its articles, unlisted, under new ids. */
function enlarged(input) {
  const articles = [...input.entries, ...input.unlisted];
  const extra = Array.from({ length: copies }, (_, copy) =>
    articles.map((entry) => ({ ...entry, id: entry.id + (copy + 1) * 100_000 })),
  ).flat();
  return { ...input, unlisted: [...input.unlisted, ...extra], more: input.more + extra.length };
}

for (const file of files) {
  const input = enlarged(JSON.parse(readFileSync(file, 'utf8')));
  for (const effort of values.efforts.split(',')) {
    const settings = instanceSettings.parse({
      apiKey,
      model: values.model,
      effort,
      userMonthlyTokens: 1_000_000_000,
    });
    const storage = new MemoryStore();
    const started = Date.now();
    const result = await compose({
      client: clientFor(settings, globalThis.fetch),
      settings,
      userSettings: reader,
      input,
      storage,
      userStorage: null,
      logger: console,
      signal: new AbortController().signal,
      deadline: started + DIGEST_LIMITS.timeoutSeconds * 1000 - 3_000,
      now: () => new Date(),
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const tokens = await usedThisMonth(storage, new Date());
    const articles = input.entries.length + input.unlisted.length;
    console.log(`\n## ${file}: ${String(articles)} articles, ${settings.model}, effort ${effort}`);
    console.log(`${result.outcome}, ${String(tokens)} tokens, ${seconds} s`);
    const titles = new Map([...input.entries, ...input.unlisted].map((e) => [e.id, e.title]));
    console.log(`\n${result.overview ?? '(no lead)'}\n`);
    for (const section of result.sections ?? []) {
      console.log(`### ${section.heading}\n`);
      for (const item of section.items) {
        console.log(`- ${item.text}`);
        for (const id of item.entries ?? []) console.log(`  - ${titles.get(id) ?? String(id)}`);
      }
      console.log('');
    }
  }
}
