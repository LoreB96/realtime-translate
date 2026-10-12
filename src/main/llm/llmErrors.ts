/**
 * LLM error type and pure error mapping (spec §6.3). No Electron imports.
 */
import type { AssistantErrorCode } from '../../shared/assistant';

export class LlmError extends Error {
  constructor(
    readonly code: AssistantErrorCode,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'LlmError';
  }
}

const MODEL_MISSING_RE = /model.*(not found|does not exist)/i;
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET']);

/** Maps a non-ok HTTP response to an assistant error code. */
export function mapHttpError(status: number, bodyText: string): AssistantErrorCode {
  if (status === 401 || status === 403) return 'llm-auth';
  if (status === 404 || MODEL_MISSING_RE.test(bodyText)) return 'llm-model-missing';
  if (status === 429) return 'rate-limited';
  return 'unknown';
}

function errCode(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const code = (v as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Maps a thrown error (fetch / stream read) to an assistant error code. `timedOut` wins:
 * the internal timeout aborts the request, which surfaces as an AbortError.
 * Checks `err.code` and `err.cause?.code` (undici wraps socket errors in a TypeError).
 */
export function mapThrown(err: unknown, timedOut: boolean): AssistantErrorCode {
  if (timedOut) return 'llm-timeout';
  if (err instanceof LlmError) return err.code;
  const code = errCode(err);
  const causeCode =
    typeof err === 'object' && err !== null
      ? errCode((err as { cause?: unknown }).cause)
      : undefined;
  if ((code && UNREACHABLE_CODES.has(code)) || (causeCode && UNREACHABLE_CODES.has(causeCode))) {
    return 'llm-unreachable';
  }
  if (err instanceof TypeError) return 'llm-unreachable';
  return 'unknown';
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}

/** A DOMException('AbortError')-like error, used when the caller aborts. */
export function makeAbortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}
