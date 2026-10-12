import { memo, type JSX } from 'react';
import type { TranscriptEntry } from '../../../shared/assistant';
import { useT } from '../../../shared/i18n/I18nProvider';
import { rt } from '../../ipc/client';
import { displayLines } from '../../state/transcriptState';
import { retrySpeakArgs } from './speakGate';

function localTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return '';
  }
}

export const EntryBubble = memo(function EntryBubble({
  entry,
  speakBlocked,
}: {
  entry: TranscriptEntry;
  speakBlocked: boolean;
}): JSX.Element {
  const t = useT();
  const { primary, secondary } = displayLines(entry);
  const typed = entry.source === 'typed';
  const cls = ['tr-entry', `tr-entry--${entry.speaker}`, entry.final ? '' : 'tr-entry--live']
    .filter(Boolean)
    .join(' ');

  return (
    <li className={cls} title={localTime(entry.startedAt)}>
      <div className="tr-entry__meta">
        <span className="tr-entry__speaker">{t(`transcript.speaker.${entry.speaker}`)}</span>
        {typed && (
          <span className="tr-badge" title={t('transcript.typed')}>
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M1 4h14v9H1zM3 6h2v2H3zm3 0h2v2H6zm3 0h2v2H9zm3 0h1v2h-1zM4 10h8v1H4z"
                fill="currentColor"
              />
            </svg>
            {t('transcript.typed')}
          </span>
        )}
      </div>
      <div className="tr-entry__primary">{primary}</div>
      {secondary && <div className="tr-entry__secondary">{secondary}</div>}
      {typed && entry.speak && (
        <div className={`tr-entry__speak tr-entry__speak--${entry.speak}`}>
          <span>{t(`transcript.speak.${entry.speak}`)}</span>
          {entry.speak === 'error' && entry.original && (
            <button
              type="button"
              className="btn btn-ghost tr-btn-sm"
              disabled={speakBlocked}
              onClick={(): void => {
                rt.speakText(retrySpeakArgs(entry)).catch((e: unknown) => {
                  // eslint-disable-next-line no-console
                  console.warn('[transcript] speakText retry failed', e);
                });
              }}
            >
              {t('transcript.speak.retry')}
            </button>
          )}
        </div>
      )}
    </li>
  );
});
