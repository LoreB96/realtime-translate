import type { JSX } from 'react';
import { useT } from '../../../../shared/i18n/I18nProvider';
import { useStore } from '../../../state/store';
import { navigate } from '../shared/useHashRoute';
import { MeetGuide } from '../shared/MeetGuide';
import { CallDeviceNames } from '../shared/CallDeviceNames';
import { useCallDeviceLabels } from '../shared/useCallDeviceLabels';

export function Step5MeetConfig({ mode }: { mode?: 'edit' | undefined }): JSX.Element {
  const t = useT();
  const { meetConfirmed, setMeetConfirmed } = useStore();
  const labels = useCallDeviceLabels();

  const back = (): void => {
    navigate(mode === 'edit' ? { kind: 'settings', section: 'audio' } : { kind: 'wizard', step: 4 });
  };
  const proceed = (): void => {
    navigate(mode === 'edit' ? { kind: 'settings', section: 'audio' } : { kind: 'wizard', step: 6 });
  };

  return (
    <>
      <div className="setup-step-meta">{t('setup.stepLabel', { n: 5, total: 6 })} — {t('setup.meet.label')}</div>
      <h1 className="setup-heading">{t('setup.meet.heading')}</h1>
      <p className="setup-sub">{t('setup.meet.sub')}</p>

      <CallDeviceNames mic={labels.mic} speaker={labels.speaker} heading={t('setup.meet.devicesHeading')} />

      <div className="trouble-banner trouble-banner--warning" role="note">{t('setup.meet.noiseWarning')}</div>

      <MeetGuide mic={labels.mic} speaker={labels.speaker} />

      <div className="setup-note">
        <span>{t('setup.meet.otherApps')}</span>
        <button type="button" className="btn btn-secondary" onClick={(): void => navigate({ kind: 'troubleshoot' })}>
          {t('setup.meet.otherAppsButton')}
        </button>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
        <input type="checkbox" checked={meetConfirmed} onChange={(e): void => setMeetConfirmed(e.target.checked)} />
        {t('setup.meet.alreadyConfigured')}
      </label>

      <div className="setup-footer">
        <button className="btn btn-ghost" onClick={back}>{t('common.back')}</button>
        <button className="btn btn-primary" disabled={!meetConfirmed} onClick={proceed}>
          {mode === 'edit' ? t('common.saveAndBack') : t('common.next')}
        </button>
      </div>
    </>
  );
}
