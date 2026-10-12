/**
 * Wire format of the OpenAI realtime transcription session (spec §6.2.1). Pure.
 *
 * UNVERIFIED against the GA API and isolated here on purpose: the exact `session.update`
 * shape, `turn_detection: null`, and `language` vs `languages` (gpt-live-transcribe).
 */
import type { LanguageCode } from '../../shared/languages';

export const OPENAI_STT_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

/** Models that take a `languages` array instead of a single `language`. */
const LANGUAGES_ARRAY_MODELS = new Set(['gpt-live-transcribe']);

export function buildSttSessionUpdate(
  model: string,
  lang: LanguageCode,
  nearField: boolean,
): object {
  const transcription = LANGUAGES_ARRAY_MODELS.has(model)
    ? { model, languages: [lang] }
    : { model, language: lang };
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription,
          // Direction A is the raw mic; direction B was already processed by the call app.
          noise_reduction: nearField ? { type: 'near_field' } : null,
          // Commit is client-driven (the tap's silence gate), so server VAD is off.
          turn_detection: null,
        },
      },
    },
  };
}

export type SttEvent =
  | { kind: 'delta'; itemId: string; text: string }
  | { kind: 'completed'; itemId: string; text: string }
  | { kind: 'failed'; itemId: string }
  | { kind: 'error'; code: string; type: string; param?: string; fatal: boolean };

/**
 * `invalid_request_error` codes that are routine and recover by reconnecting (the server
 * closes the socket after `session_expired`; handleClose reconnects with backoff).
 */
const NON_FATAL_CODES = new Set([
  'session_expired',
  'input_audio_buffer_commit_empty',
  'conversation_already_has_active_response',
]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Parses one server frame. Unknown, irrelevant or malformed frames → undefined. */
export function parseSttEvent(raw: string): SttEvent | undefined {
  let ev: unknown;
  try {
    ev = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObj(ev) || typeof ev.type !== 'string') return undefined;
  const type = ev.type;

  if (type === 'error') {
    const err = isObj(ev.error) ? ev.error : {};
    const code = isNonEmptyStr(err.code) ? err.code : 'unknown';
    const errType = isNonEmptyStr(err.type) ? err.type : 'unknown';
    const fatal =
      code === 'invalid_api_key' ||
      (errType === 'invalid_request_error' && !NON_FATAL_CODES.has(code));
    return {
      kind: 'error',
      code,
      type: errType,
      ...(isNonEmptyStr(err.param) ? { param: err.param } : {}),
      fatal,
    };
  }

  if (!type.includes('input_audio_transcription.')) return undefined;
  const itemId = ev.item_id;
  if (!isNonEmptyStr(itemId)) return undefined;

  if (type.endsWith('input_audio_transcription.delta')) {
    return typeof ev.delta === 'string' ? { kind: 'delta', itemId, text: ev.delta } : undefined;
  }
  if (type.endsWith('input_audio_transcription.completed')) {
    return typeof ev.transcript === 'string'
      ? { kind: 'completed', itemId, text: ev.transcript }
      : undefined;
  }
  if (type.endsWith('input_audio_transcription.failed')) {
    return { kind: 'failed', itemId };
  }
  return undefined;
}
