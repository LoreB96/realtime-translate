/**
 * Call assistant (M6) shared data model: transcript entries, suggestions, STT status,
 * assistant prefs and their guards. Pure (no Electron / Node / DOM imports) so main,
 * preload and renderer can all use it. Spec §5 / §5.1.
 */
import type { Direction } from './types';
import type { LanguageCode } from './languages';

// ---------------------------------------------------------------------------
// §5 Data model
// ---------------------------------------------------------------------------

export type Speaker = 'me' | 'them';
export type TranscriptSource = 'translate' | 'stt' | 'typed';

export interface TranscriptEntry {
  /** Stable, unique for the app lifetime. ≤ 96 chars. See spec §5.2. */
  id: string;
  direction: Direction; // 'A' => me, 'B' => them
  speaker: Speaker;
  source: TranscriptSource;
  /** What was said, in the speaker's language. '' when not available. */
  original: string;
  /** Translation into the listener's language. '' when not available (yet). */
  translated: string;
  originalLang: LanguageCode;
  translatedLang: LanguageCode;
  startedAt: number; // epoch ms of first text
  updatedAt: number; // epoch ms of last change
  /** No more text will be appended (a late translation may still be patched in). */
  final: boolean;
  /** Typed entries only. */
  speak?: SpeakStatus;
}

export type SpeakStatus =
  | 'queued'
  | 'translating'
  | 'synthesizing'
  | 'speaking'
  | 'done'
  | 'error'
  | 'cancelled';

/** `text` in the user language, `translation` in their language ('' if omitted). */
export interface Suggestion {
  text: string;
  translation: string;
}

export interface SuggestionsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  forEntryId?: string; // undefined for manual requests
  items: Suggestion[];
  errorCode?: AssistantErrorCode;
  updatedAt: number;
}

export type AssistantErrorCode =
  | 'no-openai-key' // TTS or OpenAI STT without key
  | 'llm-unreachable' // ECONNREFUSED / DNS / network (Ollama not running)
  | 'llm-auth' // 401/403
  | 'llm-model-missing' // 404, "model not found", or empty model name
  | 'llm-timeout'
  | 'llm-bad-response' // unparseable or empty content
  | 'llm-truncated' // finish_reason 'length'
  | 'tts-failed'
  | 'tts-no-device' // toMeet device not configured
  | 'tts-busy-setup' // setup wizard/review is using the devices
  | 'stt-failed'
  // M7 adds 'stt-model-download-failed' (local model)
  | 'input-transcript-unsupported' // translate endpoint rejected audio.input.transcription
  | 'rate-limited' // 429
  | 'unknown';

export interface SttStatus {
  engine: SttEngine;
  /** M7 (local engine) widens this with 'loading-model' | 'ready'. */
  state: 'off' | 'listening' | 'error';
  streams: Direction[]; // directions being transcribed now
  errorCode?: AssistantErrorCode;
  // M7 (local engine) adds: progress?: number (0..1); backend?: 'webgpu' | 'wasm';
  // behind?: boolean (dropped utterances in the last 30 s)
}

/** What the transcript window needs besides prefs; pushed on change. */
export interface AssistantContext {
  langs: { user: LanguageCode; them: LanguageCode };
  translating: boolean;
  hasOpenAiKey: boolean;
  hasToMeetDevice: boolean;
  setupBusy: boolean; // setup wizard/review owns the devices: typed speech refused
}

export interface SpeakArgs {
  text: string;
  translate: boolean;
  translation?: string;
}

// ---------------------------------------------------------------------------
// §5.1 Prefs
// ---------------------------------------------------------------------------

/** M7 adds 'local'. */
export type SttEngine = 'off' | 'openai';
export type LlmPreset = 'openai' | 'ollama' | 'lmstudio' | 'custom';
export type ReasoningEffort = '' | 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface AssistantPrefs {
  sttEngine: SttEngine; // default 'off'
  sttOpenAiModel: string; // default 'gpt-4o-mini-transcribe'
  // M7 adds whisperModel: WhisperModel | 'auto'
  translateInputTranscript: boolean; // default true (applies from the next Start)
  translateTheirSpeech: boolean; // default true
  llm: { preset: LlmPreset; baseUrl: string; model: string; reasoningEffort: ReasoningEffort };
  ttsVoice: string; // default 'cedar'
  ttsModel: string; // default 'gpt-4o-mini-tts'
  ttsMonitor: boolean; // default false
  suggestionsEnabled: boolean; // default true
  autoSuggest: boolean; // default true
  transcriptOpenOnLaunch: boolean; // default false
}

export interface TranscriptWindowPrefs {
  x?: number;
  y?: number;
  width: number;
  height: number;
  alwaysOnTop: boolean;
}

export const LLM_PRESETS: Record<
  LlmPreset,
  { baseUrl: string; model: string; reasoningEffort: ReasoningEffort }
> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', reasoningEffort: 'minimal' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', reasoningEffort: 'none' },
  lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', model: '', reasoningEffort: '' },
  custom: { baseUrl: '', model: '', reasoningEffort: '' },
};

export type AssistantPrefsPatch = Partial<Omit<AssistantPrefs, 'llm'>> & {
  llm?: Partial<AssistantPrefs['llm']>;
};
/** What is on disk (`UserPrefs.assistant`): partial, and possibly invalid. */
export type StoredAssistantPrefs = AssistantPrefsPatch;
export type AssistantErrorScope = 'speak' | 'suggest' | 'stt' | 'llm';

export const DEFAULT_ASSISTANT_PREFS: AssistantPrefs = {
  sttEngine: 'off',
  sttOpenAiModel: 'gpt-4o-mini-transcribe',
  // The transcript shows the user's language first: their own words while translating
  // (input transcription) and the other side's words when not translating.
  translateInputTranscript: true,
  translateTheirSpeech: true,
  llm: { preset: 'openai', ...LLM_PRESETS.openai },
  ttsVoice: 'cedar',
  ttsModel: 'gpt-4o-mini-tts',
  ttsMonitor: false,
  suggestionsEnabled: true,
  autoSuggest: true,
  transcriptOpenOnLaunch: false,
};
export const DEFAULT_TRANSCRIPT_WINDOW: TranscriptWindowPrefs = {
  width: 420,
  height: 640,
  alwaysOnTop: false,
};
export const STT_ENGINES: readonly SttEngine[] = ['off', 'openai']; // M7 appends 'local'
export const STT_OPENAI_MODELS = [
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
  'gpt-live-transcribe',
] as const;
export const LLM_PRESET_IDS: readonly LlmPreset[] = ['openai', 'ollama', 'lmstudio', 'custom'];
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  '',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
];
export const TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;
/**
 * Male voices offered for typed speech, best first (`cedar` is OpenAI's recommended
 * highest-quality voice). The live translation voice cannot be chosen: the translate
 * endpoint rejects `audio.output.voice` (unknown_parameter, seen 2026-10-12).
 */
export const MALE_TTS_VOICES = ['cedar', 'ash', 'ballad', 'echo', 'verse', 'onyx', 'fable'] as const;
export const MAX_SPEAK_CHARS = 2000;
export const MAX_TTS_INPUT_CHARS = 4096;
export const MAX_MODEL_CHARS = 100;
export const MAX_BASE_URL_CHARS = 200;
export const MAX_LLM_KEY_CHARS = 300;
export const ASSISTANT_ERROR_CODES: readonly AssistantErrorCode[] = [
  'no-openai-key',
  'llm-unreachable',
  'llm-auth',
  'llm-model-missing',
  'llm-timeout',
  'llm-bad-response',
  'llm-truncated',
  'tts-failed',
  'tts-no-device',
  'tts-busy-setup',
  'stt-failed',
  'input-transcript-unsupported',
  'rate-limited',
  'unknown',
];

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const TTS_VOICE_RE = /^[a-z0-9_-]{1,40}$/;

const isSttEngine = (v: unknown): v is SttEngine =>
  typeof v === 'string' && (STT_ENGINES as readonly string[]).includes(v);
const isLlmPreset = (v: unknown): v is LlmPreset =>
  typeof v === 'string' && (LLM_PRESET_IDS as readonly string[]).includes(v);
/** Non-empty model id, ≤ 100 chars (STT / TTS models). */
const isRequiredModel = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_MODEL_CHARS;
/** LLM model: may be empty in prefs (LM Studio/custom start empty), ≤ 100 chars. */
const isLlmModel = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_MODEL_CHARS;
/** LLM base URL: '' (not configured yet) or a valid http(s) URL. */
const isLlmBaseUrl = (v: unknown): v is string =>
  typeof v === 'string' && (v === '' || isValidBaseUrl(v));
const isTtsVoice = (v: unknown): v is string => typeof v === 'string' && TTS_VOICE_RE.test(v);

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v);
}

export function isAssistantErrorCode(v: unknown): v is AssistantErrorCode {
  return typeof v === 'string' && (ASSISTANT_ERROR_CODES as readonly string[]).includes(v);
}

type FlatKey = Exclude<keyof AssistantPrefs, 'llm'>;
const FLAT_VALIDATORS: { [K in FlatKey]: (v: unknown) => v is AssistantPrefs[K] } = {
  sttEngine: isSttEngine,
  sttOpenAiModel: isRequiredModel,
  translateInputTranscript: isBool,
  translateTheirSpeech: isBool,
  ttsVoice: isTtsVoice,
  ttsModel: isRequiredModel,
  ttsMonitor: isBool,
  suggestionsEnabled: isBool,
  autoSuggest: isBool,
  transcriptOpenOnLaunch: isBool,
};
type LlmKey = keyof AssistantPrefs['llm'];
const LLM_VALIDATORS: { [K in LlmKey]: (v: unknown) => v is AssistantPrefs['llm'][K] } = {
  preset: isLlmPreset,
  baseUrl: isLlmBaseUrl,
  model: isLlmModel,
  reasoningEffort: isReasoningEffort,
};
const hasKey = <T extends object>(o: T, k: string): k is Extract<keyof T, string> =>
  Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
// Prefs resolution / merge / guards
// ---------------------------------------------------------------------------

/**
 * Fills defaults and drops invalid values; never throws. An unknown `sttEngine` (e.g. a
 * future 'local' read by an M6 build) becomes 'off'; stray keys are ignored. Missing or
 * invalid `llm` fields fall back to the (resolved) preset's values.
 */
export function resolveAssistantPrefs(p: StoredAssistantPrefs | undefined): AssistantPrefs {
  const out: AssistantPrefs = {
    ...DEFAULT_ASSISTANT_PREFS,
    llm: { ...DEFAULT_ASSISTANT_PREFS.llm },
  };
  const raw: unknown = p;
  if (!isObj(raw)) return out;
  const flat = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(FLAT_VALIDATORS) as FlatKey[]) {
    const v = raw[key];
    if (FLAT_VALIDATORS[key](v)) flat[key] = v;
  }
  const llmRaw = raw.llm;
  if (isObj(llmRaw)) {
    const preset: LlmPreset = isLlmPreset(llmRaw.preset) ? llmRaw.preset : 'openai';
    const base = LLM_PRESETS[preset];
    out.llm = {
      preset,
      baseUrl: isLlmBaseUrl(llmRaw.baseUrl) ? llmRaw.baseUrl : base.baseUrl,
      model: isLlmModel(llmRaw.model) ? llmRaw.model : base.model,
      reasoningEffort: isReasoningEffort(llmRaw.reasoningEffort)
        ? llmRaw.reasoningEffort
        : base.reasoningEffort,
    };
  }
  return out;
}

/** Shallow merge, except `llm`, which is merged field by field. */
export function mergeAssistantPrefs(
  base: StoredAssistantPrefs | undefined,
  patch: AssistantPrefsPatch,
): StoredAssistantPrefs {
  // `base` comes from disk: tolerate a corrupt (non-object) value instead of spreading it.
  const safeBase: StoredAssistantPrefs = isObj(base) ? base : {};
  const { llm: patchLlm, ...patchRest } = patch;
  const { llm: rawBaseLlm, ...baseRest } = safeBase;
  const baseLlm = isObj(rawBaseLlm) ? rawBaseLlm : undefined;
  const merged: StoredAssistantPrefs = { ...baseRest, ...patchRest };
  if (baseLlm !== undefined || patchLlm !== undefined) {
    merged.llm = { ...(baseLlm ?? {}), ...(patchLlm ?? {}) };
  }
  return merged;
}

/** Every key known and valid (unknown keys, `undefined` values and bad nested `llm` rejected). */
export function isAssistantPrefsPatch(v: unknown): v is AssistantPrefsPatch {
  if (!isObj(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (k === 'llm') {
      if (!isObj(val)) return false;
      for (const [lk, lv] of Object.entries(val)) {
        if (!hasKey(LLM_VALIDATORS, lk)) return false;
        if (!LLM_VALIDATORS[lk](lv)) return false;
      }
      continue;
    }
    if (!hasKey(FLAT_VALIDATORS, k)) return false;
    if (!FLAT_VALIDATORS[k](val)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// IPC argument guards
// ---------------------------------------------------------------------------

const SPEAK_KEYS = new Set(['text', 'translate', 'translation']);

/** `text` 1..2000 chars after trim; `translate` boolean; `translation?` string ≤ 4096. */
export function isSpeakArgs(v: unknown): v is SpeakArgs {
  if (!isObj(v)) return false;
  for (const k of Object.keys(v)) if (!SPEAK_KEYS.has(k)) return false;
  if (typeof v.text !== 'string') return false;
  const trimmed = v.text.trim().length;
  if (trimmed < 1 || trimmed > MAX_SPEAK_CHARS || v.text.length > MAX_TTS_INPUT_CHARS) {
    return false;
  }
  if (!isBool(v.translate)) return false;
  if (
    hasKey(v, 'translation') &&
    !(typeof v.translation === 'string' && v.translation.length <= MAX_TTS_INPUT_CHARS)
  ) {
    return false;
  }
  return true;
}

export function isExportArgs(v: unknown): v is { format: 'txt' | 'md' } {
  return isObj(v) && (v.format === 'txt' || v.format === 'md');
}

export function isLlmKeyArgs(v: unknown): v is { value: string } {
  return (
    isObj(v) &&
    typeof v.value === 'string' &&
    v.value.length >= 1 &&
    v.value.length <= MAX_LLM_KEY_CHARS
  );
}

export function isAlwaysOnTopArgs(v: unknown): v is { value: boolean } {
  return isObj(v) && isBool(v.value);
}

// ---------------------------------------------------------------------------
// URL / key helpers
// ---------------------------------------------------------------------------

function parseUrl(s: string): URL | undefined {
  try {
    return new URL(s);
  } catch {
    return undefined;
  }
}

/** True only for https://api.openai.com with the default port. */
export function isOpenAiHost(baseUrl: string): boolean {
  const u = parseUrl(baseUrl);
  if (!u) return false;
  return (
    u.protocol === 'https:' &&
    u.hostname === 'api.openai.com' &&
    (u.port === '' || u.port === '443')
  );
}

/** localhost, 127.0.0.1, [::1]. */
export function isLoopbackHost(baseUrl: string): boolean {
  const u = parseUrl(baseUrl);
  if (!u) return false;
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
}

/** Parses as an http/https URL with a host, ≤ 200 chars. */
export function isValidBaseUrl(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_BASE_URL_CHARS) return false;
  const u = parseUrl(s);
  if (!u) return false;
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0;
}

/**
 * Security: never returns openAiKey unless isOpenAiHost(baseUrl).
 * OpenAI host → openAiKey ?? customKey; any other URL → customKey only.
 */
export function selectLlmKey(
  baseUrl: string,
  openAiKey: string | undefined,
  customKey: string | undefined,
): string | undefined {
  if (isOpenAiHost(baseUrl)) return openAiKey ?? customKey;
  return customKey;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function speakerOf(d: Direction): Speaker {
  return d === 'A' ? 'me' : 'them';
}

/** Han, kana and CJK punctuation / full-width forms: languages written without spaces. */
// CJK symbols & punctuation (U+3000..U+303F) and half/full-width forms (U+FF00..U+FFEF).
const CJK_PUNCT_CLASS = String.raw`\u{3000}-\u{303f}\u{ff00}-\u{ffef}`;
const CJK_CLASS =
  String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}` + CJK_PUNCT_CLASS;
const CJK_CHAR_RE = new RegExp(`[${CJK_CLASS}]`, 'u');
const CJK_SPLIT_RE = new RegExp(`([${CJK_CLASS}])`, 'u');
const CJK_PUNCT_RE = new RegExp(`^[${CJK_PUNCT_CLASS}]$`, 'u');

function isCjkChar(ch: string | undefined): boolean {
  return ch !== undefined && CJK_CHAR_RE.test(ch);
}

/** Whitespace-separated words; each CJK character (not CJK punctuation) counts as a word. */
export function countWords(text: string): number {
  let n = 0;
  for (const token of text.split(/\s+/)) {
    if (token === '') continue;
    for (const part of token.split(CJK_SPLIT_RE)) {
      if (part === '') continue;
      if (CJK_CHAR_RE.test(part)) {
        if (!CJK_PUNCT_RE.test(part)) n += 1;
      } else if (/[\p{L}\p{N}]/u.test(part)) {
        n += 1;
      }
    }
  }
  return n;
}

/**
 * Joins transcript deltas. OpenAI streams them as token pieces that carry their own
 * spacing (" chi", " ud", "ere"), so they are concatenated as-is: inserting a space would
 * split words ("ud ere"). Two fixes on top: a doubled space at the seam is collapsed, and a
 * missing space after a sentence end (".", "!", "?", "…") before a letter is added — that
 * happens when separate segments are appended (late translation, STT segments).
 */
export function joinDelta(prev: string, delta: string): string {
  if (prev === '') return delta.trimStart();
  if (delta === '') return prev;
  if (/\s$/u.test(prev) && /^\s/u.test(delta)) return prev + delta.replace(/^\s+/u, '');
  const first = Array.from(delta)[0];
  if (/[.!?…]$/u.test(prev) && /^\p{L}/u.test(delta) && !isCjkChar(first)) {
    return `${prev} ${delta}`;
  }
  return prev + delta;
}
