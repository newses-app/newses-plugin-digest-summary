/*
 * Messages API responses as the API returns them, for the fake API: an answer, a refusal, an
 * answer from a fallback model after a refusal, and an answer cut off at max_tokens.
 */

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  inference_geo: 'global',
  server_tool_use: null,
  service_tier: 'standard',
});

const thinking = { type: 'thinking', thinking: '', signature: 'EqQBCkgIBxABGAIiQ...' };

/** A message answering with `answer` as its JSON text. */
export function answered(answer: unknown, tokens: { input: number; output: number }) {
  return {
    id: 'msg_01FakeAnswered',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [thinking, { type: 'text', text: JSON.stringify(answer) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: usage(tokens.input, tokens.output),
  };
}

/** A message the model declined: no content, `stop_reason: refusal`. */
export const refused = {
  id: 'msg_01FakeRefused',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [],
  stop_reason: 'refusal',
  stop_sequence: null,
  stop_details: {
    type: 'refusal',
    category: 'general_harms',
    explanation: 'The request was declined.',
  },
  usage: usage(900, 0),
};

/** The requested model declined, and the server's default fallback answered. */
export function fellBack(answer: unknown) {
  return {
    id: 'msg_01FakeFellBack',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: [
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'text', text: JSON.stringify(answer) },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      ...usage(950, 120),
      iterations: [
        { type: 'message', model: 'claude-opus-5-5', ...usage(900, 0) },
        { type: 'fallback_message', model: 'claude-opus-4-8', ...usage(950, 120) },
      ],
    },
  };
}

/** A message cut off at max_tokens, its JSON unfinished. */
export const cutOff = {
  id: 'msg_01FakeCutOff',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [thinking, { type: 'text', text: '{"overview": "The week in' }],
  stop_reason: 'max_tokens',
  stop_sequence: null,
  stop_details: null,
  usage: usage(900, 8000),
};

/** A batch result line: a succeeded message, or an errored or expired item. */
export const batchLine = {
  succeeded: (customId: string, message: unknown) => ({
    custom_id: customId,
    result: { type: 'succeeded', message },
  }),
  errored: (customId: string) => ({
    custom_id: customId,
    result: {
      type: 'errored',
      error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    },
  }),
  expired: (customId: string) => ({ custom_id: customId, result: { type: 'expired' } }),
};
