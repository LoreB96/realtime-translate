import type { JSX } from 'react';
import { useT } from '../../shared/i18n/I18nProvider';
import { formatUsd } from '../../shared/usage';
import type { BarServices } from '../state/useBarServices';

/**
 * Bar quick toggles: transcript (when not translating), reply suggestions, and the button
 * that opens the transcript window (typed speech lives there).
 */
export function BarServiceButtons({
  services,
  onOpenTranscript,
}: {
  services: BarServices;
  onOpenTranscript: () => void;
}): JSX.Element | null {
  const t = useT();
  const { prefs, context, savePrefs } = services;
  if (!prefs) return null;

  const hasKey = context?.hasOpenAiKey ?? true;
  const sttOn = prefs.sttEngine !== 'off';
  const translating = context?.translating ?? false;
  const sttTitle = !hasKey
    ? t('bar.tooltip.transcribeNoKey')
    : translating
      ? t('bar.tooltip.transcribeIncluded')
      : sttOn
        ? t('bar.tooltip.transcribeOn')
        : t('bar.tooltip.transcribeOff');
  const suggestOn = prefs.suggestionsEnabled;

  return (
    <div className="rt-svc-group">
      <button
        type="button"
        className={`rt-svc${sttOn || translating ? ' rt-svc--on' : ''}`}
        aria-pressed={sttOn}
        disabled={!hasKey && !sttOn}
        title={sttTitle}
        aria-label={sttTitle}
        onClick={(): void => savePrefs({ sttEngine: sttOn ? 'off' : 'openai' })}
      >
        {/* captions */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M7 15h4M15 15h2M7 11h2M13 11h4" />
        </svg>
      </button>
      <button
        type="button"
        className={`rt-svc${suggestOn ? ' rt-svc--on' : ''}`}
        aria-pressed={suggestOn}
        title={suggestOn ? t('bar.tooltip.suggestOn') : t('bar.tooltip.suggestOff')}
        aria-label={suggestOn ? t('bar.tooltip.suggestOn') : t('bar.tooltip.suggestOff')}
        onClick={(): void => savePrefs({ suggestionsEnabled: !suggestOn })}
      >
        {/* lightbulb */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18h6M10 22h4" />
          <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
        </svg>
      </button>
      <button
        type="button"
        className="rt-svc"
        title={t('bar.tooltip.transcript')}
        aria-label={t('bar.tooltip.transcript')}
        onClick={onOpenTranscript}
      >
        {/* message with text */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M7 8h10M7 12h6" />
        </svg>
      </button>
    </div>
  );
}

/** Spend since launch/reset; opens the services and costs panel. */
export function CostChip({
  services,
  open,
  onToggle,
}: {
  services: BarServices;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const t = useT();
  const total = services.usage?.totalUsd ?? 0;
  return (
    <button
      type="button"
      className={`rt-cost-chip${open ? ' rt-cost-chip--open' : ''}`}
      aria-expanded={open}
      title={t('bar.tooltip.costs')}
      onClick={onToggle}
    >
      <span>{formatUsd(total)}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <path d="M6 15l6-6 6 6" />
      </svg>
    </button>
  );
}
