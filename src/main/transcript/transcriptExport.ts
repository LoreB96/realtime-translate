/**
 * Formats the transcript for export as plain text or Markdown (spec §6.1). Pure: the caller shows
 * the save dialog and writes the file. Export is the only time transcript content reaches disk.
 */
import type { TranscriptEntry } from '@shared/assistant';
import type { T } from '@shared/i18n';

export interface FormatTranscriptOptions {
  format: 'txt' | 'md';
  t: T;
  date: Date;
  /** IANA time zone for the header date and entry times; defaults to the system zone. */
  tz?: string;
}

function entryText(e: TranscriptEntry): string {
  const original = e.original.trim();
  const translated = e.translated.trim();
  if (original && translated) return `${original} — ${translated}`;
  return original || translated;
}

export function formatTranscript(
  entries: readonly TranscriptEntry[],
  opts: FormatTranscriptOptions,
): string {
  const tzOpt: Intl.DateTimeFormatOptions = opts.tz ? { timeZone: opts.tz } : {};
  const header = opts.t('transcript.export.header', {
    date: opts.date.toLocaleDateString('en-GB', tzOpt),
  });
  const md = opts.format === 'md';

  const lines: string[] = [];
  for (const e of entries) {
    const text = entryText(e);
    if (!text) continue;
    const time = new Date(e.startedAt).toLocaleTimeString('en-GB', { hour12: false, ...tzOpt });
    const speaker = opts.t(
      e.speaker === 'me' ? 'transcript.speaker.me' : 'transcript.speaker.them',
    );
    lines.push(md ? `[${time}] **${speaker}:** ${text}` : `[${time}] ${speaker}: ${text}`);
  }

  // Markdown needs blank lines between entries, or they would merge into one paragraph.
  const body = lines.join(md ? '\n\n' : '\n');
  const head = md ? `# ${header}` : header;
  return body ? `${head}\n\n${body}\n` : `${head}\n`;
}
