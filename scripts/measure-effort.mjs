// Runs digest requests against the Anthropic API at each effort, to choose the `effort` setting:
// the tokens each used, how long it took, and what it wrote. Every run is billed to the key.
//
//   npm run build && ANTHROPIC_API_KEY=sk-ant-... node scripts/measure-effort.mjs [DIGEST.json ...]
//     [--efforts low,medium,high] [--model claude-opus-5-5]
//
// A digest file is what `digest.compose` is given (see scripts/sample-digest.json, the default).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
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
  },
});
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY to a key from the Claude Console');
const files = positionals.length
  ? positionals
  : [new URL('sample-digest.json', import.meta.url).pathname];

for (const file of files) {
  const input = JSON.parse(readFileSync(file, 'utf8'));
  for (const effort of values.efforts.split(',')) {
    const settings = instanceSettings.parse({ apiKey, model: values.model, effort });
    const storage = new MemoryStore();
    const started = Date.now();
    const result = await compose({
      client: clientFor(settings, globalThis.fetch),
      settings,
      userSettings: userSettings.parse({}),
      input,
      storage,
      userStorage: null,
      logger: console,
      signal: new AbortController().signal,
      deadline: started + 120_000,
      now: () => new Date(),
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const tokens = await usedThisMonth(storage, new Date());
    console.log(`\n## ${file}: ${settings.model}, effort ${effort}`);
    console.log(`${result.outcome}, ${tokens} tokens, ${seconds} s`);
    console.log(`\n${result.overview ?? '(no overview)'}\n`);
    for (const entry of result.entries ?? []) console.log(`- ${entry.id}: ${entry.text}`);
  }
}
