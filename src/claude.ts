import Anthropic from '@anthropic-ai/sdk';
import type { InstanceSettings } from './settings.js';

/** The API's host, which an admin approves for the plugin. */
export const API_HOST = 'api.anthropic.com';

/** Server-side fallback when the model declines, on direct requests only. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * A client sending requests through the hook's `fetch`, with the key from the settings. The host,
 * key, and logging are set here, so nothing in the server's environment (`ANTHROPIC_*`) changes
 * where requests go or what credentials they carry.
 */
export function clientFor(
  settings: Pick<InstanceSettings, 'apiKey'>,
  fetch: typeof globalThis.fetch,
): Anthropic {
  return new Anthropic({
    apiKey: settings.apiKey,
    authToken: null,
    baseURL: `https://${API_HOST}`,
    fetch,
    maxRetries: 1,
    timeout: 40_000,
    logLevel: 'off',
  });
}

/** The text a response ends with: its text blocks after any switch to a fallback model. */
export function finalText(content: readonly { type: string; text?: string }[]): string {
  const switched = content.findLastIndex((block) => block.type === 'fallback');
  return content
    .slice(switched + 1)
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('');
}

/** An API failure as people read it, without anything from the request. */
export function failureText(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError)
    return 'The API key was refused (HTTP 401): check it in the server’s settings';
  if (error instanceof Anthropic.PermissionDeniedError)
    return 'The API key may not use this model (HTTP 403)';
  if (error instanceof Anthropic.NotFoundError) return 'The model was not found (HTTP 404)';
  if (error instanceof Anthropic.RateLimitError) return 'Rate limited by the API (HTTP 429)';
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'The API did not answer in time';
  if (error instanceof Anthropic.APIConnectionError)
    return error.cause instanceof Error
      ? `The API could not be reached: ${error.cause.message}`
      : 'The API could not be reached';
  if (error instanceof Anthropic.APIError && error.status !== undefined)
    return `The API answered HTTP ${String(error.status)}`;
  return error instanceof Error ? error.message : String(error);
}
