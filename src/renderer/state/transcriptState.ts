/**
 * Transcript window view state (M6, spec §11.1). Pure: no React, no DOM, no IPC, so the
 * reducer and selectors are unit-tested directly.
 */
import type {
  AssistantContext,
  AssistantErrorCode,
  AssistantErrorScope,
  AssistantPrefs,
  SttStatus,
  SuggestionsState,
  TranscriptEntry,
} from '../../shared/assistant';

/** Oldest entries are dropped beyond this many. */
export const MAX_VIEW_ENTRIES = 500;

export interface TranscriptViewState {
  entries: TranscriptEntry[];
  suggestions: SuggestionsState;
  stt: SttStatus;
  prefs: AssistantPrefs;
  context: AssistantContext;
  lastError?: { scope: AssistantErrorScope; code: AssistantErrorCode; at: number };
}

export type TranscriptAction =
  | { type: 'snapshot'; entries: TranscriptEntry[] }
  | { type: 'upsert'; entry: TranscriptEntry }
  | { type: 'cleared' }
  | { type: 'suggestions'; s: SuggestionsState }
  | { type: 'stt'; s: SttStatus }
  | { type: 'prefs'; p: AssistantPrefs }
  | { type: 'context'; c: AssistantContext }
  | { type: 'error'; scope: AssistantErrorScope; code: AssistantErrorCode; at: number };

export function initialTranscriptState(prefs: AssistantPrefs): TranscriptViewState {
  return {
    entries: [],
    suggestions: { status: 'idle', items: [], updatedAt: 0 },
    stt: { engine: prefs.sttEngine, state: 'off', streams: [] },
    prefs,
    // Conservative until the real context arrives: typed speech stays disabled.
    context: {
      langs: { user: 'en', them: 'en' },
      translating: false,
      hasOpenAiKey: false,
      hasToMeetDevice: false,
      setupBusy: false,
    },
  };
}

/** Stable sort by `startedAt`, then keep only the newest MAX_VIEW_ENTRIES. */
function normalize(entries: TranscriptEntry[]): TranscriptEntry[] {
  const sorted = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.startedAt - b.e.startedAt || a.i - b.i)
    .map((x) => x.e);
  return sorted.length > MAX_VIEW_ENTRIES ? sorted.slice(sorted.length - MAX_VIEW_ENTRIES) : sorted;
}

function upsert(entries: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx === -1) return normalize([...entries, entry]);
  const current = entries[idx];
  if (current && entry.updatedAt < current.updatedAt) return entries; // stale push
  const next = entries.slice();
  next[idx] = entry;
  return normalize(next);
}

/** Union by id; on conflict the entry with the newer `updatedAt` wins (ties keep the current one). */
function mergeSnapshot(entries: TranscriptEntry[], snapshot: TranscriptEntry[]): TranscriptEntry[] {
  const byId = new Map<string, TranscriptEntry>();
  for (const e of entries) byId.set(e.id, e);
  for (const e of snapshot) {
    const current = byId.get(e.id);
    if (!current || e.updatedAt > current.updatedAt) byId.set(e.id, e);
  }
  return normalize([...byId.values()]);
}

export function transcriptReducer(
  s: TranscriptViewState,
  a: TranscriptAction,
): TranscriptViewState {
  switch (a.type) {
    case 'snapshot':
      return { ...s, entries: mergeSnapshot(s.entries, a.entries) };
    case 'upsert':
      return { ...s, entries: upsert(s.entries, a.entry) };
    case 'cleared':
      return { ...s, entries: [] };
    case 'suggestions':
      return { ...s, suggestions: a.s };
    case 'stt':
      return { ...s, stt: a.s };
    case 'prefs':
      return { ...s, prefs: a.p };
    case 'context':
      return { ...s, context: a.c };
    case 'error':
      return { ...s, lastError: { scope: a.scope, code: a.code, at: a.at } };
    default:
      return s;
  }
}

/** Primary line in the user's language, secondary line in the other language ('' if none). */
export function displayLines(e: TranscriptEntry): { primary: string; secondary: string } {
  if (e.speaker === 'them') {
    return {
      primary: e.translated || e.original,
      secondary: e.translated ? e.original : '',
    };
  }
  return {
    primary: e.original || e.translated,
    secondary: e.original ? e.translated : '',
  };
}

export type HeaderStatus = 'translating' | 'sttOpenai' | 'off' | 'error'; // M7 adds 'sttLocal' | 'loadingModel' | 'behind'

/** Precedence: translating → error → sttOpenai → off. */
export function headerStatus(s: TranscriptViewState): HeaderStatus {
  if (s.context.translating) return 'translating';
  if (s.stt.state === 'error') return 'error';
  if (s.prefs.sttEngine === 'openai') return 'sttOpenai';
  return 'off';
}

export function showSttCta(s: TranscriptViewState): boolean {
  return !s.context.translating && s.prefs.sttEngine === 'off';
}
