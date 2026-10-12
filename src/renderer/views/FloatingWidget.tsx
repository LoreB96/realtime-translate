import { useCallback, useEffect, useState, type JSX } from 'react';
import { useStore } from '../state/store';
import { rt } from '../ipc/client';
import { selectAggregateState } from '../state/aggregateState';
import { Orb } from '../components/Orb';
import { Waveform } from '../components/Waveform';
import { LanguagePair } from '../components/LanguagePair';
import { LatencyMeter } from '../components/LatencyMeter';
import { BarServiceButtons, CostChip } from '../components/BarServiceButtons';
import { ControlPanel } from '../components/ControlPanel';
import { useBarServices } from '../state/useBarServices';
import { ActionButton } from '../components/ActionButton';
import { QuitButton, SettingsButton } from '../components/SettingsButton';
import { HealthChip } from '../components/HealthChip';
import { useHealthSubscription } from '../state/useHealthSubscription';
import { useT } from '../../shared/i18n/I18nProvider';

export function FloatingWidget(): JSX.Element {
  const {
    sourceLang, targetLang,
    stateA, stateB, latencyMs,
    update, health,
    setDirectionState, setLatency, setUpdateAvailable, setUpdateReady, hydrate,
  } = useStore();
  const t = useT();
  const services = useBarServices();
  /** Services-and-costs panel; `direction` is where main grew the window for it. */
  const [panel, setPanel] = useState<{ open: boolean; direction: 'up' | 'down' }>({
    open: false,
    direction: 'up',
  });

  const closePanel = useCallback((): void => {
    setPanel((p) => ({ ...p, open: false }));
    void rt.setBarExpanded(false);
  }, []);

  const togglePanel = async (): Promise<void> => {
    if (panel.open) {
      closePanel();
      return;
    }
    // Grow the window first, then render the panel where main made room for it.
    const { direction } = await rt.setBarExpanded(true);
    setPanel({ open: true, direction });
  };

  // Escape or clicking another app closes the panel (and shrinks the window back).
  useEffect(() => {
    if (!panel.open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', closePanel);
    return (): void => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', closePanel);
    };
  }, [panel.open, closePanel]);

  const openTranscript = (): void => {
    rt.openTranscriptView().catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[bar] openTranscriptView failed', e);
    });
  };

  useEffect(() => {
    void hydrate();
    // Settings run in a separate window with its own store and only persist to prefs —
    // re-read on focus so the language pair shown here doesn't go stale.
    const onFocus = (): void => { void hydrate(); };
    window.addEventListener('focus', onFocus);
    const offState = rt.onDirectionalState(({ direction, state }) =>
      setDirectionState(direction, state),
    );
    const offLat = rt.onLatency(({ direction, averageMs }) =>
      setLatency(direction, averageMs),
    );
    return (): void => {
      window.removeEventListener('focus', onFocus);
      offState();
      offLat();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useHealthSubscription();

  useEffect(() => {
    const offAvail = rt.onUpdateAvailable((info) => setUpdateAvailable(info));
    const offDl = rt.onUpdateDownloaded((info) => setUpdateReady(info));
    return (): void => {
      offAvail();
      offDl();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click-through on the BrowserWindow's transparent margins. The window is
  // 640x40 (taller while the panel is open) but the visible bar is width: auto.
  // Pixels outside .rt-bar / .rt-panel pass clicks through to the app below.
  // Toggles ignoreMouseEvents based on which DOM region is under the cursor;
  // forward: true keeps mousemove flowing so we can detect re-entry. Initial
  // state is ignore=true so the bar doesn't grab clicks until the user moves
  // over it.
  useEffect(() => {
    let isOnBar = false;
    const update = (e: MouseEvent): void => {
      const target = e.target as Element | null;
      const onBar = !!target?.closest?.('.rt-bar, .rt-panel');
      if (onBar !== isOnBar) {
        isOnBar = onBar;
        void rt.setBarMouseEvents({ ignore: !onBar });
      }
    };
    const onLeave = (): void => {
      if (isOnBar) {
        isOnBar = false;
        void rt.setBarMouseEvents({ ignore: true });
      }
    };
    document.addEventListener('mousemove', update);
    document.addEventListener('mouseleave', onLeave);
    void rt.setBarMouseEvents({ ignore: true });
    return (): void => {
      document.removeEventListener('mousemove', update);
      document.removeEventListener('mouseleave', onLeave);
      void rt.setBarMouseEvents({ ignore: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bar = selectAggregateState(stateA, stateB);
  const avgLatency = bar.kind === 'active'
    ? avgDefined(latencyMs.A, latencyMs.B)
    : undefined;

  const onAction = async (): Promise<void> => {
    if (bar.kind === 'idle' || bar.kind === 'error') {
      // Start from the persisted prefs, not this window's possibly stale copy — the
      // language pair or devices may have been changed in Settings since mount.
      await hydrate();
      const s = useStore.getState();
      // Both Start and Retry need full device selection. If devices are
      // missing (e.g., user cleared prefs, devices unplugged), redirect to
      // SetupView instead of passing empty strings down to the audio pipeline.
      if (!s.selectedMic || !s.selectedToMeet || !s.selectedFromMeet || !s.selectedHeadset) {
        await rt.openSetupView();
        return;
      }
      await rt.startTranslation({
        sourceLang: s.sourceLang,
        targetLang: s.targetLang,
        micDeviceId: s.selectedMic,
        toMeetDeviceId: s.selectedToMeet,
        fromMeetDeviceId: s.selectedFromMeet,
        headsetDeviceId: s.selectedHeadset,
      });
    } else {
      await rt.stopTranslation();
    }
  };

  return (
    <div className={`rt-root rt-root--${panel.direction}`}>
      {panel.open && (
        <ControlPanel
          services={services}
          bar={bar}
          onTranslate={(): void => { void onAction(); }}
          onOpenTranscript={openTranscript}
          onOpenSettings={(): void => { closePanel(); void rt.openSetupView(); }}
          onClose={closePanel}
        />
      )}
      <div
        className={`rt-bar rt-bar--${bar.kind}`}
        role="status"
        onContextMenu={(e): void => {
          e.preventDefault();
          void rt.showBarMenu();
        }}
      >
        <Orb state={bar.kind} />
        {bar.kind === 'active' && <Waveform />}
        {(bar.kind === 'idle' || bar.kind === 'active') && (
          <LanguagePair
            source={sourceLang}
            target={targetLang}
            onClick={(): void => { void rt.openSetupView(); }}
          />
        )}
        {bar.kind === 'connecting' && (
          <span className="rt-status">{t('bar.status.connecting')}</span>
        )}
        {bar.kind === 'reconnecting' && (
          <span className="rt-status">
            {t('bar.status.reconnecting')}
            <span className="rt-status__attempt"> · {bar.origin}: {t('bar.status.attempt', { n: bar.attempt })}</span>
          </span>
        )}
        {bar.kind === 'error' && (
          <span className="rt-status" title={bar.message}>
            {`${bar.origin}: ${truncate(bar.message, 28)}`}
          </span>
        )}
        <HealthChip health={health} idle={bar.kind === 'idle'} />
        <LatencyMeter ms={avgLatency} />
        {update.ready ? (
          <button
            type="button"
            className="rt-update-badge rt-update-badge--ready"
            onClick={(): void => { void rt.applyUpdate(); }}
            title={t('update.tooltipReady')}
          >
            ↑ {t('update.ready', { version: update.ready.version })}
          </button>
        ) : update.available ? (
          <span
            className="rt-update-badge rt-update-badge--downloading"
            title={t('update.tooltipAvailable', { version: update.available.version })}
          >
            ↑ {t('update.available', { version: update.available.version })}
          </span>
        ) : null}
        <ActionButton state={bar.kind} onClick={(): void => { void onAction(); }} />
        <BarServiceButtons services={services} onOpenTranscript={openTranscript} />
        <CostChip services={services} open={panel.open} onToggle={(): void => { void togglePanel(); }} />
        <SettingsButton onClick={(): void => { void rt.openSetupView(); }} />
        <QuitButton onClick={(): void => { void rt.quit(); }} />
      </div>
    </div>
  );
}

function avgDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a !== undefined && b !== undefined) return Math.round((a + b) / 2);
  return a ?? b;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
