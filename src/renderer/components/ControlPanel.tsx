import type { JSX, ReactNode } from 'react';
import { useT } from '../../shared/i18n/I18nProvider';
import {
  formatUsd,
  hourlyEstimates,
  llmPrice,
  type ServiceUsage,
  type UsageService,
} from '../../shared/usage';
import type { BarState } from '../state/aggregateState';
import type { BarServices } from '../state/useBarServices';

function Switch({
  on,
  disabled,
  label,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled === true}
      className={`rt-switch${on ? ' rt-switch--on' : ''}`}
      onClick={(): void => onChange(!on)}
    >
      <span className="rt-switch__knob" />
    </button>
  );
}

function Row({
  name,
  desc,
  active,
  control,
  spent,
  detail,
  estimate,
}: {
  name: string;
  desc: string;
  active: boolean;
  control: ReactNode;
  spent: number;
  detail: string;
  estimate: string;
}): JSX.Element {
  return (
    <div className={`rt-panel__row${active ? ' rt-panel__row--active' : ''}`}>
      <div className="rt-panel__control">{control}</div>
      <div className="rt-panel__info">
        <div className="rt-panel__name">{name}</div>
        <div className="rt-panel__desc">{desc}</div>
      </div>
      <div className="rt-panel__money">
        <div className="rt-panel__spent">{formatUsd(spent)}</div>
        <div className="rt-panel__detail">{detail}</div>
        <div className="rt-panel__estimate">{estimate}</div>
      </div>
    </div>
  );
}

/**
 * The bar's "Services and costs" panel: every paid service with its on/off control, what it
 * has cost since launch (or the last reset) and what it costs per hour of use.
 */
export function ControlPanel({
  services,
  bar,
  onTranslate,
  onOpenTranscript,
  onOpenSettings,
  onClose,
}: {
  services: BarServices;
  bar: BarState;
  onTranslate: () => void;
  onOpenTranscript: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}): JSX.Element | null {
  const t = useT();
  const { prefs, context, usage, stt, savePrefs, resetUsage } = services;
  if (!prefs) return null;

  const est = hourlyEstimates({
    sttModel: prefs.sttOpenAiModel,
    ttsModel: prefs.ttsModel,
    llmBaseUrl: prefs.llm.baseUrl,
    llmModel: prefs.llm.model,
  });
  const llmFree = !llmPrice(prefs.llm.baseUrl, prefs.llm.model).paid;
  const hasKey = context?.hasOpenAiKey ?? true;
  const translating = bar.kind !== 'idle' && bar.kind !== 'error';

  const u = (k: UsageService): ServiceUsage => usage?.[k] ?? { usd: 0, minutes: 0, calls: 0 };
  const minutes = (s: ServiceUsage): string =>
    t('panel.minutes', { n: s.minutes < 10 ? s.minutes.toFixed(1) : Math.round(s.minutes) });
  const calls = (s: ServiceUsage): string => t('panel.calls', { n: s.calls });
  const perHour = (usd: number): string =>
    usd <= 0 ? t('panel.free') : t('panel.perHour', { usd: formatUsd(usd) });
  const since = usage
    ? new Date(usage.sinceMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className="rt-panel" role="dialog" aria-label={t('panel.title')}>
      <div className="rt-panel__header">
        <span className="rt-panel__title">{t('panel.title')}</span>
        {since && <span className="rt-panel__since">{t('panel.since', { time: since })}</span>}
        <button type="button" className="rt-panel__icon-btn" onClick={onClose} aria-label={t('panel.close')} title={t('panel.close')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </div>

      <Row
        name={t('panel.translate.name')}
        desc={t('panel.translate.desc')}
        active={translating}
        control={
          <button
            type="button"
            className={`rt-panel__action${translating ? ' rt-panel__action--stop' : ''}`}
            onClick={onTranslate}
          >
            {translating ? t('panel.translate.stop') : t('panel.translate.start')}
          </button>
        }
        spent={u('translate').usd}
        detail={minutes(u('translate'))}
        estimate={perHour(est.translate)}
      />
      <Row
        name={t('panel.transcribe.name')}
        desc={hasKey ? t('panel.transcribe.desc') : t('panel.noKey')}
        active={stt?.state === 'listening' || translating}
        control={
          <Switch
            on={prefs.sttEngine !== 'off'}
            disabled={!hasKey && prefs.sttEngine === 'off'}
            label={t('panel.transcribe.name')}
            onChange={(v): void => savePrefs({ sttEngine: v ? 'openai' : 'off' })}
          />
        }
        spent={u('transcribe').usd}
        detail={minutes(u('transcribe'))}
        estimate={t('panel.upToPerHour', { usd: formatUsd(est.transcribe) })}
      />
      <Row
        name={t('panel.suggest.name')}
        desc={llmFree ? `${t('panel.suggest.desc')} · ${t('panel.localModel')}` : t('panel.suggest.desc')}
        active={prefs.suggestionsEnabled}
        control={
          <Switch
            on={prefs.suggestionsEnabled}
            label={t('panel.suggest.name')}
            onChange={(v): void => savePrefs({ suggestionsEnabled: v })}
          />
        }
        spent={u('suggest').usd}
        detail={calls(u('suggest'))}
        estimate={perHour(est.suggest)}
      />
      {prefs.suggestionsEnabled && (
        <label className="rt-panel__sub-option">
          <input
            type="checkbox"
            checked={prefs.autoSuggest}
            onChange={(e): void => savePrefs({ autoSuggest: e.target.checked })}
          />
          {t('panel.suggest.auto')}
        </label>
      )}
      <Row
        name={t('panel.voice.name')}
        desc={hasKey ? t('panel.voice.desc') : t('panel.noKey')}
        active={false}
        control={
          <button type="button" className="rt-panel__action" onClick={onOpenTranscript}>
            {t('panel.voice.open')}
          </button>
        }
        spent={u('voice').usd}
        detail={minutes(u('voice'))}
        estimate={t('panel.perMin', { usd: formatUsd(est.voicePerMin) })}
      />

      <div className="rt-panel__footer">
        <div className="rt-panel__total" title={t('panel.totalHint')}>
          <span>{t('panel.total')}</span>
          <strong>{formatUsd(usage?.totalUsd ?? 0)}</strong>
          {usage?.estimated && <span className="rt-panel__badge">{t('panel.estimated')}</span>}
        </div>
        <div className="rt-panel__footer-actions">
          <button type="button" className="rt-panel__link" onClick={resetUsage} title={t('panel.resetTitle')}>
            {t('panel.reset')}
          </button>
          <button type="button" className="rt-panel__link" onClick={onOpenSettings}>
            {t('panel.settings')}
          </button>
        </div>
      </div>
    </div>
  );
}
