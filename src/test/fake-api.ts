/*
 * A stand-in for api.anthropic.com in tests, answering with responses shaped as the API's
 * (src/test/responses.ts) and keeping each request it was sent.
 */

export interface SentRequest {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

/** What the fake answers a Messages request with: a message, or a status and error. */
export type MessageAnswer = Record<string, unknown> | { status: number; error: string } | 'hang';

export interface Batch {
  status: 'in_progress' | 'ended';
  /** Results as JSONL lines, by custom_id. */
  results: Record<string, unknown>[];
}

export class FakeApi {
  readonly requests: SentRequest[] = [];
  /** Answers to Messages requests, in order. */
  readonly messages: MessageAnswer[] = [];
  readonly batches = new Map<string, Batch>();
  /** The status `GET /v1/models/:id` answers with. */
  modelStatus = 200;
  #nextBatch = 1;

  readonly fetch: typeof globalThis.fetch = async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.text();
    this.requests.push({
      method: request.method,
      path: url.pathname,
      headers: request.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    });
    const route = `${request.method} ${url.pathname}`;
    if (route === 'POST /v1/messages') return this.#message(request.signal);
    if (route === 'POST /v1/messages/batches') {
      const id = `msgbatch_${String(this.#nextBatch++)}`;
      this.batches.set(id, { status: 'in_progress', results: [] });
      return json(batchObject(id, 'in_progress'));
    }
    const batch = /^\/v1\/messages\/batches\/([^/]+)(\/results)?$/.exec(url.pathname);
    if (request.method === 'GET' && batch?.[1]) {
      const found = this.batches.get(batch[1]);
      if (!found) return error(404, 'not_found_error');
      if (batch[2])
        return new Response(found.results.map((line) => JSON.stringify(line)).join('\n'), {
          headers: { 'content-type': 'application/binary' },
        });
      return json(batchObject(batch[1], found.status));
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1/models/'))
      return this.modelStatus === 200
        ? json({
            type: 'model',
            id: url.pathname.slice('/v1/models/'.length),
            display_name: 'Claude',
            created_at: '2026-10-01T00:00:00Z',
          })
        : error(this.modelStatus, 'authentication_error');
    return error(404, 'not_found_error');
  };

  /** The Messages requests sent, their bodies. */
  get messageBodies(): Record<string, unknown>[] {
    return this.requests
      .filter((request) => request.method === 'POST' && request.path === '/v1/messages')
      .map((request) => request.body ?? {});
  }

  #message(signal: AbortSignal): Promise<Response> {
    const answer = this.messages.shift();
    if (answer === undefined) throw new Error('the fake API has no answer left for a message');
    if (answer === 'hang')
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    if ('status' in answer && 'error' in answer)
      return Promise.resolve(error(answer.status as number, answer.error as string));
    return Promise.resolve(json(answer));
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const error = (status: number, type: string) =>
  json({ type: 'error', error: { type, message: type } }, status);

function batchObject(id: string, status: 'in_progress' | 'ended') {
  return {
    id,
    type: 'message_batch',
    processing_status: status,
    request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    created_at: '2026-11-17T08:00:00Z',
    expires_at: '2026-11-18T08:00:00Z',
    ended_at: status === 'ended' ? '2026-11-17T08:05:00Z' : null,
    archived_at: null,
    cancel_initiated_at: null,
    results_url:
      status === 'ended' ? `https://api.anthropic.com/v1/messages/batches/${id}/results` : null,
  };
}
