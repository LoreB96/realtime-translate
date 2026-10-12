/**
 * Spend tracking for the paid services (translation, transcription, voice, AI model).
 * Pure: shared by the main-process UsageMeter and the bar's cost panel.
 *
 * Prices are OpenAI list prices in USD as of 2026-10 (see docs/QA-CHECKLIST.md, M6 notes).
 * They are estimates: the OpenAI usage dashboard is the authority. Change them here only.
 */
import { isOpenAiHost } from './assistant';

/** gpt-realtime-translate: USD per session-minute, per direction. */
export const TRANSLATE_USD_PER_MIN = 0.034;

/** Realtime transcription: USD per minute of audio sent (only speech passes the gate). */
export const STT_USD_PER_MIN: Readonly<Record<string, number>> = {
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe': 0.006,
  'gpt-live-transcribe': 0.017,
};
const STT_FALLBACK_USD_PER_MIN = 0.006;

/** Text to speech: USD per minute of generated audio ($12 / 1M audio tokens). */
export const TTS_USD_PER_MIN: Readonly<Record<string, number>> = {
  'gpt-4o-mini-tts': 0.015,
};
const TTS_FALLBACK_USD_PER_MIN = 0.015;

/** Chat models: USD per 1M tokens, input and output. */
export const LLM_USD_PER_MTOK: Readonly<Record<string, { in: number; out: number }>> = {
  'gpt-5': { in: 1.25, out: 10 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
};
/** Unknown OpenAI model: priced like gpt-5-mini and flagged as estimated. */
const LLM_FALLBACK = { in: 0.25, out: 2 };

/** PCM16 mono 24 kHz: bytes per second of audio (STT input and TTS output). */
export const PCM24K_BYTES_PER_S = 48_000;

export type LlmPurpose = 'suggest' | 'speak' | 'their' | 'test';

export interface LlmPrice {
  in: number;
  out: number;
  /** False for local/other servers (free). */
  paid: boolean;
  /** True when the model is not in the table and the price is a guess. */
  guessed: boolean;
}

export function sttUsdPerMin(model: string): number {
  return STT_USD_PER_MIN[model] ?? STT_FALLBACK_USD_PER_MIN;
}

export function ttsUsdPerMin(model: string): number {
  return TTS_USD_PER_MIN[model] ?? TTS_FALLBACK_USD_PER_MIN;
}

/** Price of a chat model; models on non-OpenAI servers (Ollama, LM Studio…) are free. */
export function llmPrice(baseUrl: string, model: string): LlmPrice {
  if (!isOpenAiHost(baseUrl)) return { in: 0, out: 0, paid: false, guessed: false };
  // Dated snapshots ('gpt-5-mini-2025-08-07') price like their base model.
  const known =
    LLM_USD_PER_MTOK[model] ??
    Object.entries(LLM_USD_PER_MTOK)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([k]) => model.startsWith(`${k}-`))?.[1];
  return known
    ? { ...known, paid: true, guessed: false }
    : { ...LLM_FALLBACK, paid: true, guessed: true };
}

export function llmCallUsd(price: LlmPrice, promptTokens: number, completionTokens: number): number {
  return (promptTokens * price.in + completionTokens * price.out) / 1_000_000;
}

/** One service's spend since the meter was last reset. */
export interface ServiceUsage {
  usd: number;
  /** Minutes billed (translation session-minutes, STT/TTS audio minutes); 0 for LLM-only. */
  minutes: number;
  /** LLM calls counted under this service. */
  calls: number;
}

/**
 * Spend since `sinceMs`, grouped the way the bar shows it:
 * - translate:   translation sessions (both directions);
 * - transcribe:  transcription audio + translating what they say;
 * - suggest:     reply suggestions;
 * - voice:       typed speech: translation of the text + text to speech.
 */
export interface UsageSnapshot {
  sinceMs: number;
  translate: ServiceUsage;
  transcribe: ServiceUsage;
  suggest: ServiceUsage;
  voice: ServiceUsage;
  totalUsd: number;
  /** Some LLM costs were estimated (no `usage` in the reply, or unknown model price). */
  estimated: boolean;
}

export type UsageService = 'translate' | 'transcribe' | 'suggest' | 'voice';
export const USAGE_SERVICES: readonly UsageService[] = [
  'translate',
  'transcribe',
  'suggest',
  'voice',
];

export function emptyUsage(sinceMs: number): UsageSnapshot {
  const z = (): ServiceUsage => ({ usd: 0, minutes: 0, calls: 0 });
  return {
    sinceMs,
    translate: z(),
    transcribe: z(),
    suggest: z(),
    voice: z(),
    totalUsd: 0,
    estimated: false,
  };
}

/** Typical-use cost estimates, in USD per hour of call, for the bar's cost panel. */
export interface HourlyEstimates {
  /** Both directions translating for the whole hour. */
  translate: number;
  /** Upper bound: both sides speaking non-stop (silence is not sent, so real use is lower). */
  transcribe: number;
  /** About one suggestion per minute of conversation; 0 on a local model. */
  suggest: number;
  /** Per minute of typed speech (voice + translating the text). */
  voicePerMin: number;
}

/** Assumed tokens of one reply-suggestion call (prompt with recent transcript, short reply). */
const SUGGEST_TOKENS = { in: 2500, out: 600 };
/** Assumed tokens of translating one minute of typed text (~150 words). */
const SPEAK_TOKENS_PER_MIN = { in: 400, out: 300 };

export function hourlyEstimates(p: {
  sttModel: string;
  ttsModel: string;
  llmBaseUrl: string;
  llmModel: string;
}): HourlyEstimates {
  const llm = llmPrice(p.llmBaseUrl, p.llmModel);
  return {
    translate: 2 * TRANSLATE_USD_PER_MIN * 60,
    transcribe: 2 * sttUsdPerMin(p.sttModel) * 60,
    suggest: 60 * llmCallUsd(llm, SUGGEST_TOKENS.in, SUGGEST_TOKENS.out),
    voicePerMin:
      ttsUsdPerMin(p.ttsModel) + llmCallUsd(llm, SPEAK_TOKENS_PER_MIN.in, SPEAK_TOKENS_PER_MIN.out),
  };
}

/** Formats USD for small amounts: "$0.004", "$0.12", "$4.08". */
export function formatUsd(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
