import type Anthropic from '@anthropic-ai/sdk';
import { NotFoundError } from '@anthropic-ai/sdk';
import type { EventEntry, EventEntryWithText, PluginLogger, PluginStore } from '@newses/plugin-api';
import { finalText } from './claude.js';
import { readSummary, SUMMARY_FORMAT, SUMMARY_SYSTEM, summaryPrompt } from './prompts.js';
import type { InstanceSettings } from './settings.js';
import { count, tokensOf } from './usage.js';

/*
 * Entries are shared: the same article reaches every user subscribed to its feed with the same
 * content hash. So each is summarised once per hash and language, kept in the instance's storage:
 *
 *   summary:<language>:<hash>  { summary: string | null } when done (null: refused, or no answer
 *                              worth keeping), or { batch: id } while a batch has it
 *   batch:<id>                 the batch's hashes in request order, its language, and the tokens
 *                              counted for it when it was sent
 */

/** How long a summary is kept: past the oldest article a weekly digest lists. */
export const SUMMARY_TTL_SECONDS = 30 * 24 * 60 * 60;
/** How long an entry waits for its batch, which ends within 24 hours. */
const PENDING_TTL_SECONDS = 2 * 24 * 60 * 60;
/** Output tokens a summary is counted at when its batch is sent, thinking included. */
export const SUMMARY_OUTPUT_ESTIMATE = 600;
/** A summary's `max_tokens`, thinking included. */
const SUMMARY_MAX_TOKENS = 2000;

type Stored = { summary: string | null } | { batch: string };

interface BatchRecord {
  language: string;
  hashes: string[];
  /** The tokens counted for the batch when it was sent, corrected once its results are in. */
  estimate: number;
}

const summaryKey = (language: string, hash: string) => `summary:${language}:${hash}`;
const batchKey = (id: string) => `batch:${id}`;

/**
 * Whether an entry may be sent to Anthropic: never from a feed with a login, whose articles are
 * the user's own, and never a page published from outside any feed.
 */
export const sendable = (entry: EventEntry) => entry.feed !== null && !entry.feed.withLogin;

/** What is kept for an entry's hash in a language: a summary, null for none, pending, or nothing. */
export async function storedSummary(
  store: PluginStore,
  language: string,
  hash: string,
): Promise<{ summary: string | null } | 'pending' | undefined> {
  const value = (await store.get(summaryKey(language, hash))) as Stored | undefined;
  if (!value) return undefined;
  return 'batch' in value ? 'pending' : { summary: value.summary };
}

/** Keeps a summary, or that an entry has none. */
export async function keepSummary(
  store: PluginStore,
  language: string,
  hash: string,
  summary: string | null,
): Promise<void> {
  await store.set(summaryKey(language, hash), { summary } satisfies Stored, {
    ttlSeconds: SUMMARY_TTL_SECONDS,
  });
}

/** The tokens a summary request is counted at before it runs: about 3 characters a token. */
export const estimateTokens = (prompt: string) =>
  Math.ceil((SUMMARY_SYSTEM.length + prompt.length) / 3) + SUMMARY_OUTPUT_ESTIMATE;

/** A summary request, as a batch item. */
function summaryParams(
  settings: InstanceSettings,
  prompt: string,
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  return {
    model: settings.model,
    max_tokens: SUMMARY_MAX_TOKENS,
    output_config: { effort: settings.effort, format: SUMMARY_FORMAT },
    // Unchanging and first, so the prompt cache can serve it.
    system: [{ type: 'text', text: SUMMARY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  };
}

/**
 * Sends the entries not yet summarised in `language` as one Message Batch, as many as `allowance`
 * tokens cover, and counts their estimate. Returns how many were sent and the tokens counted.
 */
export async function submitBatch(options: {
  client: Anthropic;
  settings: InstanceSettings;
  store: PluginStore;
  entries: readonly EventEntryWithText[];
  language: string;
  allowance: number;
  signal: AbortSignal;
}): Promise<{ sent: number; tokens: number }> {
  const { client, settings, store, language, signal } = options;
  const unique = new Map<string, EventEntryWithText>();
  for (const entry of options.entries)
    if (sendable(entry) && !unique.has(entry.contentHash)) unique.set(entry.contentHash, entry);
  const kept = await Promise.all(
    [...unique.keys()].map((hash) => storedSummary(store, language, hash)),
  );
  const wanted = [...unique.values()].filter((_, index) => kept[index] === undefined);

  const items: { hash: string; prompt: string }[] = [];
  let tokens = 0;
  for (const entry of wanted) {
    const prompt = summaryPrompt(
      { title: entry.title, feed: entry.feed?.title ?? '', text: entry.text },
      language,
    );
    const estimate = estimateTokens(prompt);
    if (tokens + estimate > options.allowance) break;
    tokens += estimate;
    items.push({ hash: entry.contentHash, prompt });
  }
  if (items.length === 0) return { sent: 0, tokens: 0 };

  const batch = await client.messages.batches.create(
    {
      requests: items.map((item, index) => ({
        custom_id: `s${String(index)}`,
        params: summaryParams(settings, item.prompt),
      })),
    },
    { signal },
  );
  const record: BatchRecord = {
    language,
    hashes: items.map((item) => item.hash),
    estimate: tokens,
  };
  await store.set(batchKey(batch.id), record, { ttlSeconds: 30 * 24 * 60 * 60 });
  await Promise.all(
    items.map((item) =>
      store.set(summaryKey(language, item.hash), { batch: batch.id } satisfies Stored, {
        ttlSeconds: PENDING_TTL_SECONDS,
      }),
    ),
  );
  return { sent: items.length, tokens };
}

/**
 * Keeps the summaries of batches that have ended, until `deadline` (ms since the epoch): a
 * refused or unreadable answer as none, an errored or expired item as nothing, to be summarised
 * in a digest instead. Corrects the instance's count from the batch's estimate to what it used.
 * Returns how many batches it finished.
 */
export async function collectBatches(options: {
  client: Anthropic;
  store: PluginStore;
  logger: PluginLogger;
  deadline: number;
  signal: AbortSignal;
  now: () => Date;
}): Promise<number> {
  const { client, store, logger, signal } = options;
  let finished = 0;
  for (const { key, value } of await store.list('batch:', { limit: 20 })) {
    if (Date.now() >= options.deadline) break;
    const id = key.slice('batch:'.length);
    const record = value as BatchRecord;
    try {
      const batch = await client.messages.batches.retrieve(id, null, { signal });
      if (batch.processing_status !== 'ended') continue;
      let used = 0;
      const seen = new Set<string>();
      for await (const item of await client.messages.batches.results(id, undefined, { signal })) {
        const hash = record.hashes[Number(item.custom_id.slice(1))];
        if (hash === undefined) continue;
        seen.add(hash);
        if (item.result.type !== 'succeeded') {
          await store.delete(summaryKey(record.language, hash));
          continue;
        }
        const message = item.result.message;
        used += tokensOf(message.usage);
        const summary =
          message.stop_reason === 'end_turn' ? readSummary(finalText(message.content)) : null;
        await keepSummary(store, record.language, hash, summary);
      }
      for (const hash of record.hashes)
        if (!seen.has(hash)) await store.delete(summaryKey(record.language, hash));
      await count(store, used - record.estimate, options.now());
      await store.delete(key);
      finished += 1;
    } catch (error) {
      if (error instanceof NotFoundError) {
        await store.delete(key);
        continue;
      }
      logger.warn('could not collect a summary batch', { batch: id, error: String(error) });
      break;
    }
  }
  return finished;
}
