import { useEffect, useState, type JSX } from 'react';
import { useT } from '../../../../shared/i18n/I18nProvider';
import { rt } from '../../../ipc/client';
import { useStore } from '../../../state/store';
import { useHealthSubscription } from '../../../state/useHealthSubscription';
import { navigate, type SettingsSection } from '../shared/useHashRoute';
import { SetupTitlebar } from '../shared/SetupTitlebar';
import { TroubleshootScreen } from '../troubleshoot/TroubleshootScreen';
import { Step6TestTranslation } from '../wizard/Step6TestTranslation';
import { AudioSection } from './AudioSection';
import { GeneralSection } from './GeneralSection';
import {
  AiModelSection,
  SuggestionsSection,
  TranscriptionSection,
  VoiceSection,
} from './assistantSections';

/** Left navigation, grouped. Order inside a group is the order shown. */
const GROUPS: { id: 'call' | 'assistant' | 'help'; sections: SettingsSection[] }[] = [
  { id: 'call', sections: ['general', 'audio', 'test'] },
  { id: 'assistant', sections: ['transcription', 'ai', 'voice', 'suggestions'] },
  { id: 'help', sections: ['troubleshoot'] },
];

function SectionBody({ section }: { section: SettingsSection }): JSX.Element | null {
  switch (section) {
    case 'general': return <GeneralSection />;
    case 'audio': return <AudioSection />;
    case 'test': return <Step6TestTranslation mode="edit" />;
    case 'transcription': return <TranscriptionSection />;
    case 'ai': return <AiModelSection />;
    case 'voice': return <VoiceSection />;
    case 'suggestions': return <SuggestionsSection />;
    case 'troubleshoot': return <TroubleshootScreen embedded />;
  }
}

/**
 * Settings after the first-run setup: one window, a short grouped list on the left, one
 * section on the right. Every change saves immediately, so there is no Save/Back flow.
 */
export function SettingsScreen({ section }: { section: SettingsSection }): JSX.Element {
  const t = useT();
  useHealthSubscription();
  const health = useStore((s) => s.health);
  const devicesOk = useStore((s) =>
    Boolean(s.selectedMic && s.selectedToMeet && s.selectedFromMeet && s.selectedHeadset),
  );
  const [hasKey, setHasKey] = useState(true);

  useEffect(() => {
    rt.hasApiKey().then(setHasKey).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[settings] hasApiKey failed', e);
    });
  }, [section]);

  /** Sections that need attention get a dot in the navigation. */
  const attention: Partial<Record<SettingsSection, boolean>> = {
    general: !hasKey,
    audio: !devicesOk,
    troubleshoot: health.issues.length > 0,
  };

  return (
    <div className="setup-shell">
      <SetupTitlebar titleSuffix={t('settings.title')} />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('settings.title')}>
          {GROUPS.map((g) => (
            <div key={g.id} className="settings-nav__group">
              <div className="settings-nav__group-title">{t(`settings.group.${g.id}`)}</div>
              {g.sections.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`settings-nav__item${s === section ? ' active' : ''}`}
                  aria-current={s === section ? 'page' : undefined}
                  onClick={(): void => navigate({ kind: 'settings', section: s })}
                >
                  <span>{t(`settings.nav.${s}`)}</span>
                  {attention[s] && <span className="settings-nav__dot" aria-hidden="true" />}
                </button>
              ))}
            </div>
          ))}
          <div className="settings-nav__footer">
            <button
              type="button"
              className="settings-nav__item settings-nav__item--muted"
              onClick={(): void => navigate({ kind: 'wizard', step: 1 })}
            >
              {t('settings.wizard')}
            </button>
          </div>
        </nav>

        <main className="settings-main">
          <header className="settings-main__header">
            <div>
              <h1 className="settings-main__title">{t(`settings.nav.${section}`)}</h1>
              <p className="settings-main__sub">{t(`settings.sub.${section}`)}</p>
            </div>
            <button type="button" className="btn btn-ghost" onClick={(): void => window.close()}>
              {t('settings.close')}
            </button>
          </header>
          <div className="settings-main__body" key={section}>
            <SectionBody section={section} />
          </div>
        </main>
      </div>
    </div>
  );
}
