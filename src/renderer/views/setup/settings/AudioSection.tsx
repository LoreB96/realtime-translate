import { useEffect, useState, type JSX } from 'react';
import { useT } from '../../../../shared/i18n/I18nProvider';
import { rt } from '../../../ipc/client';
import { useStore } from '../../../state/store';
import { bothCablesPresent } from '../shared/cables';
import { CallDeviceNames } from '../shared/CallDeviceNames';
import { MeetGuide } from '../shared/MeetGuide';
import { useCallDeviceLabels } from '../shared/useCallDeviceLabels';
import { DeviceField } from '../wizard/Step4Devices';

/**
 * Virtual cables, the four audio devices and the call-app setup on one page. Main pauses
 * call audio while this section is open and re-applies the devices when you leave it.
 */
export function AudioSection(): JSX.Element {
  const t = useT();
  const labels = useCallDeviceLabels();
  const {
    devices,
    selectedMic, selectedToMeet, selectedFromMeet, selectedHeadset,
    setDevices, setSelectedMic, setSelectedToMeet, setSelectedFromMeet, setSelectedHeadset,
  } = useStore();
  const [scanning, setScanning] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  const scan = async (): Promise<void> => {
    setScanning(true);
    try {
      setDevices(await rt.listDevices());
      // Main may have re-found a saved device under a new id while listing: show it.
      await useStore.getState().hydrate();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[settings] listDevices failed', e);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cablesOk = devices ? bothCablesPresent(devices) : null;
  const placeholder = t('setup.devices.selectPlaceholder');
  const recommended = t('setup.devices.recommended');

  // The cables are listed apart from inputs/outputs; merge them back so they are selectable.
  const withCable = (
    list: { deviceId: string; label: string }[],
    cable: { deviceId: string; label: string } | undefined,
  ): { deviceId: string; label: string }[] =>
    !cable || list.some((o) => o.deviceId === cable.deviceId) ? list : [cable, ...list];
  const toMeetOptions = withCable(devices?.outputs ?? [], devices?.cableA?.playback);
  const fromMeetOptions = withCable(devices?.inputs ?? [], devices?.cableB?.recording);

  const staleCables =
    Boolean(devices?.cableA?.playback && selectedToMeet && selectedToMeet !== devices.cableA.playback.deviceId) ||
    Boolean(devices?.cableB?.recording && selectedFromMeet && selectedFromMeet !== devices.cableB.recording.deviceId);

  return (
    <>
      <div className="trouble-callout">{t('settings.audio.liveNote')}</div>

      <section className="trouble-section">
        <h2 className="trouble-section__title">{t('settings.audio.cables')}</h2>
        <div className="settings-row">
          {cablesOk === null ? (
            <span className="settings-status">{t('setup.cables.detecting')}</span>
          ) : (
            <span className={`settings-status settings-status--${cablesOk ? 'ok' : 'warn'}`}>
              {cablesOk ? t('review.section.cablesOk') : t('review.section.cablesMissing')}
            </span>
          )}
          <div className="settings-row__actions">
            {cablesOk === false && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={(): void => {
                  void rt.openExternalUrl('https://vb-audio.com/Cable/index.htm#DownloadCableAB');
                }}
              >
                {t('setup.cables.downloadButton')}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={scanning}
              onClick={(): void => { void scan(); }}
            >
              {t('review.section.rescan')}
            </button>
          </div>
        </div>
      </section>

      <section className="trouble-section">
        <h2 className="trouble-section__title">{t('settings.audio.devices')}</h2>
        {staleCables && (
          <div className="setup-stale-banner">
            <span>⚠ {t('setup.devices.staleCableWarning')}</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={(): void => {
                if (devices?.cableA?.playback) setSelectedToMeet(devices.cableA.playback.deviceId);
                if (devices?.cableB?.recording) setSelectedFromMeet(devices.cableB.recording.deviceId);
              }}
            >
              {t('setup.devices.useRecommended')}
            </button>
          </div>
        )}
        <div className="settings-devices">
          <DeviceField
            label={t('setup.devices.mic')}
            hint={t('setup.devices.micHint')}
            value={selectedMic}
            onChange={setSelectedMic}
            options={devices?.inputs ?? []}
            placeholder={placeholder}
          />
          <DeviceField
            label={t('setup.devices.headset')}
            hint={t('setup.devices.headsetHint')}
            value={selectedHeadset}
            onChange={setSelectedHeadset}
            options={devices?.outputs ?? []}
            placeholder={placeholder}
          />
          <DeviceField
            label={t('setup.devices.toMeet')}
            hint={t('setup.devices.toMeetHint')}
            value={selectedToMeet}
            onChange={setSelectedToMeet}
            options={toMeetOptions}
            placeholder={placeholder}
            recommendedId={devices?.cableA?.playback?.deviceId}
            recommendedLabel={recommended}
          />
          <DeviceField
            label={t('setup.devices.fromMeet')}
            hint={t('setup.devices.fromMeetHint')}
            value={selectedFromMeet}
            onChange={setSelectedFromMeet}
            options={fromMeetOptions}
            placeholder={placeholder}
            recommendedId={devices?.cableB?.recording?.deviceId}
            recommendedLabel={recommended}
          />
        </div>
      </section>

      <section className="trouble-section">
        <h2 className="trouble-section__title">{t('settings.audio.callApp')}</h2>
        <CallDeviceNames mic={labels.mic} speaker={labels.speaker} heading={t('setup.meet.devicesHeading')} />
        <button
          type="button"
          className="btn btn-secondary"
          aria-expanded={guideOpen}
          onClick={(): void => setGuideOpen((v) => !v)}
        >
          {guideOpen ? t('settings.audio.hideGuide') : t('settings.audio.showGuide')}
        </button>
        {guideOpen && (
          <div className="settings-guide">
            <div className="trouble-banner trouble-banner--warning" role="note">{t('setup.meet.noiseWarning')}</div>
            <MeetGuide mic={labels.mic} speaker={labels.speaker} />
          </div>
        )}
      </section>
    </>
  );
}
