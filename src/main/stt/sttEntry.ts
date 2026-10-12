import { joinDelta, speakerOf, type TranscriptEntry } from '../../shared/assistant';
import type { LanguageCode } from '../../shared/languages';
import type { SttSegment } from './sttTypes';

/**
 * Pure: folds one STT segment into the transcript entry for its item (spec §6.2).
 * Returns undefined for an empty segment with no previous entry (nothing to show).
 */
export function sttSegmentToEntry(
  prev: TranscriptEntry | undefined,
  s: SttSegment,
  langs: { user: LanguageCode; them: LanguageCode },
  now: number,
): TranscriptEntry | undefined {
  if (prev === undefined && s.text.trim() === '') return undefined;
  const base = prev?.original ?? '';
  const original = s.mode === 'replace' ? s.text : joinDelta(base, s.text);
  const mine = s.direction === 'A';
  return {
    id: `stt-${s.id}`,
    direction: s.direction,
    speaker: speakerOf(s.direction),
    source: 'stt',
    original,
    translated: prev?.translated ?? '',
    originalLang: mine ? langs.user : langs.them,
    translatedLang: mine ? langs.them : langs.user,
    startedAt: prev?.startedAt ?? now,
    updatedAt: now,
    final: (prev?.final ?? false) || s.final,
  };
}
