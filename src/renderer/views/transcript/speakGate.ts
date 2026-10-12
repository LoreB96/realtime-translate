import type {
  AssistantContext,
  SpeakArgs,
  Suggestion,
  TranscriptEntry,
} from '../../../shared/assistant';

export type SpeakBlockReason = 'noKey' | 'noDevice' | 'setupBusy';

/** Why typed speech cannot be sent right now (first match wins), or null when it can. */
export function speakBlockReason(c: AssistantContext): SpeakBlockReason | null {
  if (!c.hasOpenAiKey) return 'noKey';
  if (!c.hasToMeetDevice) return 'noDevice';
  if (c.setupBusy) return 'setupBusy';
  return null;
}

/** Speak a suggestion: use its translation when present, else ask main to translate. */
export function suggestionSpeakArgs(s: Suggestion): SpeakArgs {
  return s.translation
    ? { text: s.text, translate: false, translation: s.translation }
    : { text: s.text, translate: true };
}

/** Retry a failed typed entry, reusing its translation when one was produced. */
export function retrySpeakArgs(e: TranscriptEntry): SpeakArgs {
  return e.translated
    ? { text: e.original, translate: false, translation: e.translated }
    : { text: e.original, translate: true };
}

const ACTIVE_SPEAK = new Set(['queued', 'translating', 'synthesizing', 'speaking']);

/** True while any typed entry is still queued or being spoken. */
export function isSpeaking(entries: readonly TranscriptEntry[]): boolean {
  return entries.some((e) => e.speak !== undefined && ACTIVE_SPEAK.has(e.speak));
}
