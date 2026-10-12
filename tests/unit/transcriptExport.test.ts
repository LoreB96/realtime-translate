import { describe, it, expect } from 'vitest';
import { formatTranscript } from '@main/transcript/transcriptExport';
import { createT, getDictionary } from '@shared/i18n';
import type { TranscriptEntry } from '@shared/assistant';

const t = createT(getDictionary('en-US'));
const date = new Date(Date.UTC(2026, 9, 12, 23, 30, 0));

function entry(over: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    id: 'x',
    direction: 'A',
    speaker: 'me',
    source: 'translate',
    original: '',
    translated: '',
    originalLang: 'it',
    translatedLang: 'en',
    startedAt: Date.UTC(2026, 9, 12, 14, 5, 9),
    updatedAt: 0,
    final: true,
    ...over,
  };
}

const entries: TranscriptEntry[] = [
  entry({ id: '1', original: 'Ciao', translated: 'Hello' }),
  entry({
    id: '2',
    direction: 'B',
    speaker: 'them',
    original: 'How are you?',
    translated: '',
    startedAt: Date.UTC(2026, 9, 12, 14, 5, 20),
  }),
  entry({ id: '3', original: '  ', translated: '' }),
  entry({
    id: '4',
    source: 'typed',
    original: '',
    translated: 'Fine, thanks',
    startedAt: Date.UTC(2026, 9, 12, 14, 6, 0),
  }),
];

describe('formatTranscript', () => {
  it('formats plain text', () => {
    expect(formatTranscript(entries, { format: 'txt', t, date, tz: 'UTC' })).toBe(
      [
        'Transcript — 12/10/2026',
        '',
        '[14:05:09] Me: Ciao — Hello',
        '[14:05:20] Them: How are you?',
        '[14:06:00] Me: Fine, thanks',
        '',
      ].join('\n'),
    );
  });

  it('formats Markdown', () => {
    expect(formatTranscript(entries, { format: 'md', t, date, tz: 'UTC' })).toBe(
      [
        '# Transcript — 12/10/2026',
        '',
        '[14:05:09] **Me:** Ciao — Hello',
        '',
        '[14:05:20] **Them:** How are you?',
        '',
        '[14:06:00] **Me:** Fine, thanks',
        '',
      ].join('\n'),
    );
  });

  it('applies the time zone to the header date and times', () => {
    const out = formatTranscript(entries.slice(0, 1), {
      format: 'txt',
      t,
      date,
      tz: 'Asia/Tokyo',
    });
    expect(out).toBe('Transcript — 13/10/2026\n\n[23:05:09] Me: Ciao — Hello\n');
  });

  it('outputs only the header for an empty transcript', () => {
    expect(formatTranscript([], { format: 'md', t, date, tz: 'UTC' })).toBe(
      '# Transcript — 12/10/2026\n',
    );
  });

  it('uses the localized speaker labels', () => {
    const tIt = createT(getDictionary('it-IT'));
    const out = formatTranscript(entries.slice(0, 1), { format: 'txt', t: tIt, date, tz: 'UTC' });
    expect(out.split('\n')[0]).toBe(tIt('transcript.export.header', { date: '12/10/2026' }));
    expect(out).toContain(`] ${tIt('transcript.speaker.me')}: Ciao — Hello`);
  });
});
