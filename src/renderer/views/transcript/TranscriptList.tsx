import { useCallback, useLayoutEffect, useRef, useState, type JSX } from 'react';
import type { TranscriptEntry } from '../../../shared/assistant';
import { useT } from '../../../shared/i18n/I18nProvider';
import { EntryBubble } from './EntryBubble';

/** Within this many px of the bottom the list follows new text. */
const STICKY_PX = 40;

export function TranscriptList({
  entries,
  speakBlocked,
}: {
  entries: TranscriptEntry[];
  speakBlocked: boolean;
}): JSX.Element {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((): void => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setShowJump(false);
  }, []);

  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= STICKY_PX;
    atBottom.current = near;
    if (near) setShowJump(false);
  };

  // Runs on every entries change (new entry or a growing live one).
  useLayoutEffect(() => {
    if (atBottom.current || entries.length === 0) scrollToBottom();
    else setShowJump(true);
  }, [entries, scrollToBottom]);

  return (
    <div className="tr-list-wrap">
      <div className="tr-list" ref={ref} onScroll={onScroll}>
        {entries.length === 0 ? (
          <p className="tr-empty">{t('transcript.empty')}</p>
        ) : (
          <ul className="tr-entries">
            {entries.map((e) => (
              <EntryBubble key={e.id} entry={e} speakBlocked={speakBlocked} />
            ))}
          </ul>
        )}
      </div>
      {showJump && (
        <button type="button" className="tr-jump" onClick={scrollToBottom}>
          {t('transcript.jumpToLatest')} ↓
        </button>
      )}
    </div>
  );
}
