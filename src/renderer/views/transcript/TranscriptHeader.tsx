import { useEffect, useRef, useState, type JSX } from 'react';
import { useT } from '../../../shared/i18n/I18nProvider';
import { ConfirmModal } from '../../components/ConfirmModal';
import { rt } from '../../ipc/client';
import { headerStatus, type TranscriptViewState } from '../../state/transcriptState';

function logFail(what: string): (e: unknown) => void {
  return (e: unknown): void => {
    // eslint-disable-next-line no-console
    console.warn(`[transcript] ${what} failed`, e);
  };
}

export function TranscriptHeader({ state }: { state: TranscriptViewState }): JSX.Element {
  const t = useT();
  const status = headerStatus(state);
  const [pinned, setPinned] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    rt.loadPrefs()
      .then((p) => {
        if (alive) setPinned(p.transcriptWindow?.alwaysOnTop ?? false);
      })
      .catch(logFail('loadPrefs'));
    return (): void => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const togglePin = (): void => {
    const next = !pinned;
    setPinned(next);
    rt.setTranscriptAlwaysOnTop(next).catch((e: unknown) => {
      setPinned(!next);
      logFail('setTranscriptAlwaysOnTop')(e);
    });
  };

  const exportAs = (format: 'txt' | 'md'): void => {
    setMenuOpen(false);
    rt.exportTranscript(format).catch(logFail('exportTranscript'));
  };

  return (
    <header className="tr-header">
      <span className={`tr-status-dot tr-status-dot--${status}`} aria-hidden="true" />
      <span className="tr-status-text">{t(`transcript.status.${status}`)}</span>
      {status === 'error' && (
        <button
          type="button"
          className="btn btn-secondary tr-btn-sm"
          onClick={(): void => {
            rt.retryStt().catch(logFail('retryStt'));
          }}
        >
          {t('transcript.status.retry')}
        </button>
      )}
      <div className="tr-header__actions">
        <button
          type="button"
          className={`tr-icon-btn${pinned ? ' tr-icon-btn--on' : ''}`}
          aria-pressed={pinned}
          title={pinned ? t('transcript.unpin') : t('transcript.pin')}
          aria-label={pinned ? t('transcript.unpin') : t('transcript.pin')}
          onClick={togglePin}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M10 1l5 5-2 1-3 3 1 4-1 1-3.5-3.5L2 16l-1-1 4.5-4.5L2 7l1-1 4 1 3-3z"
              fill="currentColor"
            />
          </svg>
        </button>
        <div className="tr-menu" ref={menuRef}>
          <button
            type="button"
            className="tr-icon-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={t('transcript.menu.more')}
            aria-label={t('transcript.menu.more')}
            onClick={(): void => setMenuOpen((o) => !o)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="tr-menu__popover" role="menu">
              <button
                type="button"
                role="menuitem"
                className="tr-menu__item"
                onClick={(): void => {
                  setMenuOpen(false);
                  setConfirmOpen(true);
                }}
              >
                {t('transcript.menu.clear')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="tr-menu__item"
                onClick={(): void => exportAs('txt')}
              >
                {t('transcript.menu.exportTxt')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="tr-menu__item"
                onClick={(): void => exportAs('md')}
              >
                {t('transcript.menu.exportMd')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="tr-menu__item"
                onClick={(): void => {
                  setMenuOpen(false);
                  rt.openAssistantSettings().catch(logFail('openAssistantSettings'));
                }}
              >
                {t('transcript.menu.settings')}
              </button>
            </div>
          )}
        </div>
      </div>
      <ConfirmModal
        open={confirmOpen}
        message={t('transcript.confirmClear')}
        confirmLabel={t('transcript.menu.clearConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={(): void => {
          setConfirmOpen(false);
          rt.clearTranscript().catch(logFail('clearTranscript'));
        }}
        onCancel={(): void => setConfirmOpen(false)}
      />
    </header>
  );
}
