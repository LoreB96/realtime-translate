import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/events';
import type { IpcInvokeMap, IpcSendMap } from './ipc/channels';

type InvokeResult<K extends keyof IpcInvokeMap> = Promise<IpcInvokeMap[K]['result']>;

/** Typed `ipcRenderer.on` wrapper returning an unsubscribe function. */
function subscribe<K extends keyof IpcSendMap>(
  channel: K,
  cb: (payload: IpcSendMap[K]) => void,
): () => void {
  const handler = (_evt: unknown, payload: IpcSendMap[K]): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return (): void => {
    ipcRenderer.off(channel, handler);
  };
}

const api = {
  hasApiKey: (): Promise<IpcInvokeMap[typeof IPC.GetApiKeyStatus]['result']> =>
    ipcRenderer.invoke(IPC.GetApiKeyStatus),
  getApiKeyHint: (): Promise<IpcInvokeMap[typeof IPC.GetApiKeyHint]['result']> =>
    ipcRenderer.invoke(IPC.GetApiKeyHint),
  setApiKey: (
    value: IpcInvokeMap[typeof IPC.SetApiKey]['args']['value'],
  ): Promise<IpcInvokeMap[typeof IPC.SetApiKey]['result']> =>
    ipcRenderer.invoke(IPC.SetApiKey, { value }),
  clearApiKey: (): Promise<IpcInvokeMap[typeof IPC.ClearApiKey]['result']> =>
    ipcRenderer.invoke(IPC.ClearApiKey),
  listDevices: (): Promise<IpcInvokeMap[typeof IPC.ListDevices]['result']> =>
    ipcRenderer.invoke(IPC.ListDevices),
  startTranslation: (
    args: IpcInvokeMap[typeof IPC.StartTranslation]['args'],
  ): Promise<IpcInvokeMap[typeof IPC.StartTranslation]['result']> =>
    ipcRenderer.invoke(IPC.StartTranslation, args),
  stopTranslation: (): Promise<IpcInvokeMap[typeof IPC.StopTranslation]['result']> =>
    ipcRenderer.invoke(IPC.StopTranslation),

  loadPrefs: (): Promise<IpcInvokeMap[typeof IPC.PrefsLoad]['result']> =>
    ipcRenderer.invoke(IPC.PrefsLoad),
  saveWidgetPosition: (
    pos: IpcInvokeMap[typeof IPC.PrefsSetWidgetPosition]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetWidgetPosition, pos),
  saveLanguages: (
    langs: IpcInvokeMap[typeof IPC.PrefsSetLanguages]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetLanguages, langs),
  saveDevices: (
    devices: IpcInvokeMap[typeof IPC.PrefsSetDevices]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetDevices, devices),
  saveUiLanguage: (
    locale: IpcInvokeMap[typeof IPC.PrefsSetUiLanguage]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetUiLanguage, locale),
  saveMeetConfirmed: (
    value: IpcInvokeMap[typeof IPC.PrefsSetMeetConfirmed]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.PrefsSetMeetConfirmed, value),

  openSetupView: (): Promise<IpcInvokeMap[typeof IPC.OpenSetupView]['result']> =>
    ipcRenderer.invoke(IPC.OpenSetupView),

  markSetupComplete: (): Promise<IpcInvokeMap[typeof IPC.SetupComplete]['result']> =>
    ipcRenderer.invoke(IPC.SetupComplete),

  showBarMenu: (): Promise<IpcInvokeMap[typeof IPC.ShowBarMenu]['result']> =>
    ipcRenderer.invoke(IPC.ShowBarMenu),

  setBarMouseEvents: (
    args: IpcInvokeMap[typeof IPC.SetBarMouseEvents]['args'],
  ): Promise<IpcInvokeMap[typeof IPC.SetBarMouseEvents]['result']> =>
    ipcRenderer.invoke(IPC.SetBarMouseEvents, args),

  setBarExpanded: (expanded: boolean): InvokeResult<typeof IPC.SetBarExpanded> =>
    ipcRenderer.invoke(IPC.SetBarExpanded, { expanded }),

  quit: (): Promise<IpcInvokeMap[typeof IPC.AppQuit]['result']> =>
    ipcRenderer.invoke(IPC.AppQuit),

  openExternalUrl: (
    url: IpcInvokeMap[typeof IPC.OpenExternalUrl]['args']['url'],
  ): Promise<IpcInvokeMap[typeof IPC.OpenExternalUrl]['result']> =>
    ipcRenderer.invoke(IPC.OpenExternalUrl, { url }),

  resolveLocale: (): Promise<IpcInvokeMap[typeof IPC.ResolveLocale]['result']> =>
    ipcRenderer.invoke(IPC.ResolveLocale),

  // Test Translation (M4 Phase E) — see TestSessionRegistry + loopbackCapture.
  testSessionStart: (
    args: IpcInvokeMap[typeof IPC.TestSessionStart]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestSessionStart, args),
  testSessionInject: (
    args: IpcInvokeMap[typeof IPC.TestSessionInject]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestSessionInject, args),
  testSessionInputDone: (
    args: IpcInvokeMap[typeof IPC.TestSessionInputDone]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestSessionInputDone, args),
  testSessionStop: (
    args: IpcInvokeMap[typeof IPC.TestSessionStop]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestSessionStop, args),
  loopbackStart: (
    args: IpcInvokeMap[typeof IPC.LoopbackStart]['args'],
  ): Promise<{ detected: boolean }> => ipcRenderer.invoke(IPC.LoopbackStart, args),
  testRoutePlayback: (
    args: IpcInvokeMap[typeof IPC.TestRoutePlayback]['args'],
  ): Promise<void> => ipcRenderer.invoke(IPC.TestRoutePlayback, args),
  /**
   * Subscribe to translated audio chunks emitted by a TestSession. The channel
   * name is dynamic (`test:audio:A` / `test:audio:B`) to keep per-direction
   * subscriptions independent. Bypasses the typed IpcSendMap by design.
   */
  onTestAudio: (
    direction: 'A' | 'B',
    cb: (base64: string) => void,
  ): (() => void) => {
    const handler = (_evt: unknown, b64: string): void => cb(b64);
    ipcRenderer.on(`test:audio:${direction}`, handler);
    return (): void => {
      ipcRenderer.off(`test:audio:${direction}`, handler);
    };
  },

  onDirectionalState: (
    cb: (s: IpcSendMap[typeof IPC.DirectionalStateChanged]) => void,
  ): (() => void) => {
    const handler = (_evt: unknown, s: IpcSendMap[typeof IPC.DirectionalStateChanged]): void =>
      cb(s);
    ipcRenderer.on(IPC.DirectionalStateChanged, handler);
    return (): void => {
      ipcRenderer.off(IPC.DirectionalStateChanged, handler);
    };
  },
  onTranscript: (cb: (t: IpcSendMap[typeof IPC.TranscriptDelta]) => void): (() => void) => {
    const handler = (_evt: unknown, t: IpcSendMap[typeof IPC.TranscriptDelta]): void => cb(t);
    ipcRenderer.on(IPC.TranscriptDelta, handler);
    return (): void => {
      ipcRenderer.off(IPC.TranscriptDelta, handler);
    };
  },
  onLatency: (cb: (m: IpcSendMap[typeof IPC.LatencyMeasured]) => void): (() => void) => {
    const handler = (_evt: unknown, m: IpcSendMap[typeof IPC.LatencyMeasured]): void => cb(m);
    ipcRenderer.on(IPC.LatencyMeasured, handler);
    return (): void => {
      ipcRenderer.off(IPC.LatencyMeasured, handler);
    };
  },

  // Auto-update bindings (M5 Task 6). Main broadcasts UpdateAvailable +
  // UpdateDownloaded as the wrapper sees those events from electron-updater;
  // FloatingWidget shows a badge in response. Clicking the badge invokes
  // ApplyUpdate, which calls autoUpdater.quitAndInstall().
  applyUpdate: (): Promise<IpcInvokeMap[typeof IPC.ApplyUpdate]['result']> =>
    ipcRenderer.invoke(IPC.ApplyUpdate),

  // Audio health + diagnostics.
  getHealth: (): Promise<IpcInvokeMap[typeof IPC.HealthGet]['result']> =>
    ipcRenderer.invoke(IPC.HealthGet),
  runDiagnostics: (): Promise<IpcInvokeMap[typeof IPC.RunDiagnostics]['result']> =>
    ipcRenderer.invoke(IPC.RunDiagnostics),
  openTroubleshooting: (): Promise<IpcInvokeMap[typeof IPC.OpenTroubleshooting]['result']> =>
    ipcRenderer.invoke(IPC.OpenTroubleshooting),
  onHealth: (cb: (r: IpcSendMap[typeof IPC.HealthChanged]) => void): (() => void) => {
    const handler = (_evt: unknown, r: IpcSendMap[typeof IPC.HealthChanged]): void => cb(r);
    ipcRenderer.on(IPC.HealthChanged, handler);
    return (): void => {
      ipcRenderer.off(IPC.HealthChanged, handler);
    };
  },

  // Assistant (M6): transcript window, assistant settings, typed speech, suggestions, STT.
  openTranscriptView: (): InvokeResult<typeof IPC.OpenTranscriptView> =>
    ipcRenderer.invoke(IPC.OpenTranscriptView),
  openAssistantSettings: (): InvokeResult<typeof IPC.OpenAssistantSettings> =>
    ipcRenderer.invoke(IPC.OpenAssistantSettings),
  getTranscript: (): InvokeResult<typeof IPC.TranscriptGet> =>
    ipcRenderer.invoke(IPC.TranscriptGet),
  clearTranscript: (): InvokeResult<typeof IPC.TranscriptClear> =>
    ipcRenderer.invoke(IPC.TranscriptClear),
  exportTranscript: (
    format: IpcInvokeMap[typeof IPC.TranscriptExport]['args']['format'],
  ): InvokeResult<typeof IPC.TranscriptExport> =>
    ipcRenderer.invoke(IPC.TranscriptExport, { format }),
  setTranscriptAlwaysOnTop: (value: boolean): InvokeResult<typeof IPC.TranscriptSetAlwaysOnTop> =>
    ipcRenderer.invoke(IPC.TranscriptSetAlwaysOnTop, { value }),
  setAssistantPrefs: (
    patch: IpcInvokeMap[typeof IPC.PrefsSetAssistant]['args'],
  ): InvokeResult<typeof IPC.PrefsSetAssistant> =>
    ipcRenderer.invoke(IPC.PrefsSetAssistant, patch),
  getLlmKeyHint: (): InvokeResult<typeof IPC.LlmKeyGetHint> =>
    ipcRenderer.invoke(IPC.LlmKeyGetHint),
  setLlmKey: (value: string): InvokeResult<typeof IPC.LlmKeySet> =>
    ipcRenderer.invoke(IPC.LlmKeySet, { value }),
  clearLlmKey: (): InvokeResult<typeof IPC.LlmKeyClear> => ipcRenderer.invoke(IPC.LlmKeyClear),
  testLlm: (): InvokeResult<typeof IPC.LlmTest> => ipcRenderer.invoke(IPC.LlmTest),
  listLlmModels: (): InvokeResult<typeof IPC.LlmListModels> =>
    ipcRenderer.invoke(IPC.LlmListModels),
  speakText: (
    args: IpcInvokeMap[typeof IPC.SpeakText]['args'],
  ): InvokeResult<typeof IPC.SpeakText> => ipcRenderer.invoke(IPC.SpeakText, args),
  stopSpeaking: (): InvokeResult<typeof IPC.SpeakStop> => ipcRenderer.invoke(IPC.SpeakStop),
  suggestNow: (): InvokeResult<typeof IPC.SuggestNow> => ipcRenderer.invoke(IPC.SuggestNow),
  getSuggestions: (): InvokeResult<typeof IPC.SuggestionsGet> =>
    ipcRenderer.invoke(IPC.SuggestionsGet),
  getSttStatus: (): InvokeResult<typeof IPC.SttStatusGet> =>
    ipcRenderer.invoke(IPC.SttStatusGet),
  retryStt: (): InvokeResult<typeof IPC.SttRetry> => ipcRenderer.invoke(IPC.SttRetry),
  getAssistantContext: (): InvokeResult<typeof IPC.AssistantContextGet> =>
    ipcRenderer.invoke(IPC.AssistantContextGet),
  getUsage: (): InvokeResult<typeof IPC.UsageGet> => ipcRenderer.invoke(IPC.UsageGet),
  resetUsage: (): InvokeResult<typeof IPC.UsageReset> => ipcRenderer.invoke(IPC.UsageReset),
  onUsage: (cb: (u: IpcSendMap[typeof IPC.UsageChanged]) => void): (() => void) =>
    subscribe(IPC.UsageChanged, cb),

  onTranscriptEntry: (cb: (e: IpcSendMap[typeof IPC.TranscriptEntry]) => void): (() => void) =>
    subscribe(IPC.TranscriptEntry, cb),
  onTranscriptCleared: (cb: () => void): (() => void) =>
    subscribe(IPC.TranscriptCleared, () => cb()),
  onSuggestions: (cb: (s: IpcSendMap[typeof IPC.SuggestionsChanged]) => void): (() => void) =>
    subscribe(IPC.SuggestionsChanged, cb),
  onSttStatus: (cb: (s: IpcSendMap[typeof IPC.SttStatusChanged]) => void): (() => void) =>
    subscribe(IPC.SttStatusChanged, cb),
  onAssistantError: (cb: (e: IpcSendMap[typeof IPC.AssistantError]) => void): (() => void) =>
    subscribe(IPC.AssistantError, cb),
  onAssistantPrefs: (
    cb: (p: IpcSendMap[typeof IPC.AssistantPrefsChanged]) => void,
  ): (() => void) => subscribe(IPC.AssistantPrefsChanged, cb),
  onAssistantContext: (
    cb: (c: IpcSendMap[typeof IPC.AssistantContextChanged]) => void,
  ): (() => void) => subscribe(IPC.AssistantContextChanged, cb),

  onUpdateAvailable: (
    cb: (info: IpcSendMap[typeof IPC.UpdateAvailable]) => void,
  ): (() => void) => {
    const handler = (_evt: unknown, info: IpcSendMap[typeof IPC.UpdateAvailable]): void =>
      cb(info);
    ipcRenderer.on(IPC.UpdateAvailable, handler);
    return (): void => {
      ipcRenderer.off(IPC.UpdateAvailable, handler);
    };
  },
  onUpdateDownloaded: (
    cb: (info: IpcSendMap[typeof IPC.UpdateDownloaded]) => void,
  ): (() => void) => {
    const handler = (_evt: unknown, info: IpcSendMap[typeof IPC.UpdateDownloaded]): void =>
      cb(info);
    ipcRenderer.on(IPC.UpdateDownloaded, handler);
    return (): void => {
      ipcRenderer.off(IPC.UpdateDownloaded, handler);
    };
  },
};

declare global {
  interface Window {
    rt: typeof api;
  }
}

contextBridge.exposeInMainWorld('rt', api);

export type RtApi = typeof api;
