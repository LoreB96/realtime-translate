import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '../../shared/events';
import type { IpcInvokeMap } from './channels';
import { ConfigStore } from '../config/configStore';
import { UserPrefsStore } from '../config/userPrefsStore';
import type {
  BidirectionalArgs,
  DeviceInventory,
  DiagnosticsResult,
  Direction,
  HealthReport,
} from '../../shared/types';
import type { Locale } from '../../shared/i18n';
import type { LanguageCode } from '../../shared/languages';

export type PrefsChange = 'languages' | 'devices' | 'apiKey';

export interface HandlerDeps {
  configStore: ConfigStore;
  prefsStore: UserPrefsStore;
  /**
   * Gate for every invoke: false rejects the call. Must check that the sender is one of
   * our UI windows showing one of our own pages — window.rt can open devices, play tones
   * into the call and start paid sessions.
   */
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
  /**
   * Translation start. The implementation in SessionManager (src/main/translate/sessionManager.ts)
   * is responsible for emitting `{ direction, state: { kind: 'error' } }` via the
   * DirectionalStateChanged channel BEFORE rejecting this promise. The IPC layer just rethrows.
   *
   * Per SessionManager contract: if start() rejects, the surviving direction may still be
   * running — caller must invoke onStop() to clean up. The wiring in app.ts handles this.
   */
  onStart: (args: BidirectionalArgs) => Promise<void>;
  onStop: () => Promise<void>;
  listDevices: () => Promise<DeviceInventory>;
  openSetupView: () => Promise<void>;
  onSetupComplete: () => Promise<void>;
  showBarMenu: (sender: Electron.WebContents) => void;
  setBarMouseEvents: (args: { ignore: boolean }) => void;
  setBarExpanded: (args: { expanded: boolean }) => { direction: 'up' | 'down' };
  quitApp: () => void;
  openExternalUrl: (url: string) => Promise<void>;
  resolveLocale: () => Locale;
  // Test Translation (M4 Phase E) — see TestSessionRegistry + loopbackCapture.
  testSessionStart: (args: {
    direction: Direction;
    sourceLang: LanguageCode;
    targetLang: LanguageCode;
  }) => void;
  testSessionInject: (args: { direction: Direction; base64: string }) => void;
  testSessionInputDone: (args: { direction: Direction }) => void;
  testSessionStop: (args: { direction: Direction }) => void;
  runLoopback: (
    deviceId: string,
    thresholdRms: number,
    timeoutMs: number,
  ) => Promise<{ detected: boolean }>;
  runTestPlayback: (direction: Direction, deviceId: string, base64: string) => Promise<void>;
  applyUpdate: () => Promise<void>;
  // Audio health + diagnostics.
  getHealth: () => HealthReport;
  /** Runs against the SAVED device prefs; the renderer can't pass device ids. */
  runDiagnostics: () => Promise<DiagnosticsResult>;
  openTroubleshooting: () => Promise<void>;
  /**
   * Assistant (M6): fire-and-forget hook, called after a successful PrefsSetLanguages,
   * PrefsSetDevices, SetApiKey or ClearApiKey (not when the write throws). Its return
   * value is ignored and it never changes the invoke result.
   */
  onPrefsChanged?: (what: PrefsChange) => void;
}

type InvokeHandler<K extends keyof IpcInvokeMap> = (
  e: IpcMainInvokeEvent,
  args: IpcInvokeMap[K]['args'],
) => Promise<IpcInvokeMap[K]['result']> | IpcInvokeMap[K]['result'];

export function registerIpcHandlers(deps: HandlerDeps): void {
  const handle = <K extends keyof IpcInvokeMap>(channel: K, handler: InvokeHandler<K>): void => {
    // Cast: ipcMain.handle's signature is too loose to express our typed map.
    const typed = handler as (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    ipcMain.handle(channel, (e, ...args) => {
      if (!deps.isTrustedSender(e)) throw new Error(`untrusted sender for ${channel}`);
      return typed(e, ...args);
    });
  };

  /**
   * Runs `write`, then (only if it did not throw) the onPrefsChanged hook. The hook is
   * fire-and-forget: its errors (sync or async) never fail a write that already succeeded.
   */
  const notifying = <T>(what: PrefsChange, write: () => T): T => {
    const result = write();
    try {
      const r: unknown = deps.onPrefsChanged?.(what);
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      // Ignored: see above.
    }
    return result;
  };

  handle(IPC.PrefsLoad, () => deps.prefsStore.load());
  handle(IPC.PrefsSetWidgetPosition, (_e, pos) => deps.prefsStore.setWidgetPosition(pos));
  handle(IPC.PrefsSetLanguages, (_e, langs) =>
    notifying('languages', () => deps.prefsStore.setLanguages(langs)),
  );
  handle(IPC.PrefsSetDevices, (_e, devices) =>
    notifying('devices', () => deps.prefsStore.setDevices(devices)),
  );
  handle(IPC.PrefsSetUiLanguage, (_e, locale) => deps.prefsStore.setUiLanguage(locale));
  handle(IPC.PrefsSetMeetConfirmed, (_e, value) => deps.prefsStore.setMeetConfirmed(value));

  handle(IPC.GetApiKeyStatus, () => deps.configStore.getApiKey() !== undefined);
  handle(IPC.GetApiKeyHint, () => {
    const key = deps.configStore.getApiKey();
    return key && key.length > 4 ? key.slice(-4) : undefined;
  });
  handle(IPC.SetApiKey, (_e, args) =>
    notifying('apiKey', () => deps.configStore.setApiKey(args.value)),
  );
  handle(IPC.ClearApiKey, () => notifying('apiKey', () => deps.configStore.clearApiKey()));
  handle(IPC.ListDevices, () => deps.listDevices());
  handle(IPC.StartTranslation, (_e, args) => deps.onStart(args));
  handle(IPC.StopTranslation, () => deps.onStop());
  handle(IPC.OpenSetupView, () => deps.openSetupView());
  handle(IPC.SetupComplete, () => deps.onSetupComplete());
  handle(IPC.ShowBarMenu, (e) => deps.showBarMenu(e.sender));
  handle(IPC.SetBarMouseEvents, (_e, args) => deps.setBarMouseEvents(args));
  handle(IPC.SetBarExpanded, (_e, args) => {
    if (typeof args !== 'object' || args === null || typeof args.expanded !== 'boolean') {
      throw new Error('invalid-args');
    }
    return deps.setBarExpanded({ expanded: args.expanded });
  });
  handle(IPC.AppQuit, () => deps.quitApp());
  handle(IPC.OpenExternalUrl, (_e, args) => deps.openExternalUrl(args.url));
  handle(IPC.ResolveLocale, () => deps.resolveLocale());

  handle(IPC.TestSessionStart, (_e, args) => deps.testSessionStart(args));
  handle(IPC.TestSessionInject, (_e, args) => deps.testSessionInject(args));
  handle(IPC.TestSessionInputDone, (_e, args) => deps.testSessionInputDone(args));
  handle(IPC.TestSessionStop, (_e, args) => deps.testSessionStop(args));
  handle(IPC.LoopbackStart, (_e, args) =>
    deps.runLoopback(args.deviceId, args.thresholdRms, args.timeoutMs),
  );
  handle(IPC.TestRoutePlayback, (_e, args) =>
    deps.runTestPlayback(args.direction, args.deviceId, args.base64),
  );
  handle(IPC.ApplyUpdate, () => deps.applyUpdate());

  handle(IPC.HealthGet, () => deps.getHealth());
  handle(IPC.RunDiagnostics, () => deps.runDiagnostics());
  handle(IPC.OpenTroubleshooting, () => deps.openTroubleshooting());
}
