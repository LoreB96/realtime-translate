import { useState, type JSX } from 'react';
import type { SuggestionsState } from '../../../shared/assistant';
import { useT } from '../../../shared/i18n/I18nProvider';
import { rt } from '../../ipc/client';
import { suggestionSpeakArgs } from './speakGate';

const COLLAPSED_KEY = 'rt.transcript.suggestionsCollapsed';
const MAX_CARDS = 3;

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0');
  } catch {
    // Per-viewer convenience only; ignore blocked storage.
  }
}

function logFail(what: string): (e: unknown) => void {
  return (e: unknown): void => {
    // eslint-disable-next-line no-console
    console.warn(`[transcript] ${what} failed`, e);
  };
}

export function SuggestionsPanel({
  suggestions,
  showNeedsStt,
  speakBlocked,
  onEdit,
}: {
  suggestions: SuggestionsState;
  showNeedsStt: boolean;
  speakBlocked: boolean;
  onEdit: (text: string) => void;
}): JSX.Element {
  const t = useT();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const loading = suggestions.status === 'loading';
  const items = suggestions.items.slice(0, MAX_CARDS);

  const toggle = (): void => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  return (
    <section className={`tr-sugg${collapsed ? ' tr-sugg--collapsed' : ''}`}>
      <div className="tr-sugg__head">
        <span className="tr-sugg__title">{t('transcript.suggestions.title')}</span>
        <button
          type="button"
          className="btn btn-secondary tr-btn-sm"
          disabled={loading}
          onClick={(): void => {
            rt.suggestNow().catch(logFail('suggestNow'));
          }}
        >
          {t('transcript.suggestions.suggest')}
        </button>
        <button
          type="button"
          className="btn btn-ghost tr-btn-sm"
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          {collapsed ? t('transcript.suggestions.show') : t('transcript.suggestions.hide')}
        </button>
      </div>
      {!collapsed && (
        <div className="tr-sugg__body">
          {showNeedsStt && <p className="tr-hint">{t('transcript.suggestions.needsStt')}</p>}
          {loading && (
            <div className="tr-sugg__loading" aria-live="polite">
              <div className="tr-shimmer" />
              <div className="tr-shimmer" />
              <span className="tr-hint">{t('transcript.suggestions.loading')}</span>
            </div>
          )}
          {suggestions.status === 'error' && suggestions.errorCode && (
            <p className="tr-error">{t(`assistant.errors.${suggestions.errorCode}`)}</p>
          )}
          {suggestions.status === 'ready' && items.length === 0 && (
            <p className="tr-hint">{t('transcript.suggestions.empty')}</p>
          )}
          {!loading &&
            items.map((s, i) => (
              <div className="tr-card" key={`${suggestions.updatedAt}-${i}`}>
                <button
                  type="button"
                  className="tr-card__body"
                  title={t('transcript.suggestions.edit')}
                  onClick={(): void => onEdit(s.text)}
                >
                  <span className="tr-card__text">{s.text}</span>
                  {s.translation && <span className="tr-card__translation">{s.translation}</span>}
                </button>
                <button
                  type="button"
                  className="btn btn-primary tr-btn-sm"
                  disabled={speakBlocked}
                  onClick={(): void => {
                    rt.speakText(suggestionSpeakArgs(s)).catch(logFail('speakText'));
                  }}
                >
                  {t('transcript.suggestions.speak')}
                </button>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
