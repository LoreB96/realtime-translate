import { IPC } from '../../shared/events';
import type {
  BidirectionalArgs,
  DeviceInventory,
  DiagnosticsResult,
  Direction,
  DirectionalState,
  HealthReport,
} from '../../shared/types';
import type {
  UserPrefs, WidgetPosition, Languages, DevicePrefs,
} from '../config/userPrefsStore';
import type { Locale } from '../../shared/i18n';
import type { UsageSnapshot } from '../../shared/usage';
import type { LanguageCode } from '../../shared/languages';
import type {
  AssistantContext,
  AssistantErrorCode,
  AssistantErrorScope,
  AssistantPrefs,
  AssistantPrefsPatch,
  SpeakArgs,
  SttStatus,
  SuggestionsState,
  TranscriptEntry,
} from '../../shared/assistant';

export type LlmTestResult = { ok: true; ms: number } | { ok: false; code: AssistantErrorCode };
export type LlmModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; code: AssistantErrorCode };
export interface AssistantErrorEvent {
  scope: AssistantErrorScope;
  code: AssistantErrorCode;
}

export interface IpcInvokeMap {
  [IPC.GetApiKeyStatus]: { args: void; result: boolean };
  [IPC.GetApiKeyHint]: { args: void; result: string | undefined };
  [IPC.SetApiKey]: { args: { value: string }; result: void };
  [IPC.ClearApiKey]: { args: void; result: void };
  [IPC.ListDevices]: { args: void; result: DeviceInventory };
  [IPC.StartTranslation]: { args: BidirectionalArgs; result: void };
  [IPC.StopTranslation]: { args: void; result: void };
  [IPC.PrefsLoad]: { args: void; result: UserPrefs };
  [IPC.PrefsSetWidgetPosition]: { args: WidgetPosition; result: void };
  [IPC.PrefsSetLanguages]: { args: Languages; result: void };
  [IPC.PrefsSetDevices]: { args: DevicePrefs; result: void };
  [IPC.PrefsSetUiLanguage]: { args: Locale; result: void };
  [IPC.PrefsSetMeetConfirmed]: { args: boolean; result: void };
  [IPC.OpenSetupView]: { args: void; result: void };
  [IPC.SetupComplete]: { args: void; result: void };
  [IPC.ShowBarMenu]: { args: void; result: void };
  [IPC.SetBarMouseEvents]: { args: { ignore: boolean }; result: void };
  /** Grows the bar window for the control panel; resolves to where the panel opened. */
  [IPC.SetBarExpanded]: { args: { expanded: boolean }; result: { direction: 'up' | 'down' } };
  [IPC.AppQuit]: { args: void; result: void };
  [IPC.OpenExternalUrl]: { args: { url: string }; result: void };
  [IPC.ResolveLocale]: { args: void; result: Locale };
  [IPC.TestSessionStart]: {
    args: { direction: Direction; sourceLang: LanguageCode; targetLang: LanguageCode };
    result: void;
  };
  [IPC.TestSessionInject]: { args: { direction: Direction; base64: string }; result: void };
  [IPC.TestSessionInputDone]: { args: { direction: Direction }; result: void };
  [IPC.TestSessionStop]: { args: { direction: Direction }; result: void };
  [IPC.LoopbackStart]: {
    args: { deviceId: string; thresholdRms: number; timeoutMs: number };
    result: { detected: boolean };
  };
  [IPC.TestRoutePlayback]: {
    args: { direction: Direction; deviceId: string; base64: string };
    result: void;
  };
  [IPC.ApplyUpdate]: { args: void; result: void };
  [IPC.HealthGet]: { args: void; result: HealthReport };
  /** Runs against the SAVED device prefs — the renderer cannot pass device ids. */
  [IPC.RunDiagnostics]: { args: void; result: DiagnosticsResult };
  [IPC.OpenTroubleshooting]: { args: void; result: void };

  // Assistant (M6)
  [IPC.OpenTranscriptView]: { args: void; result: void };
  [IPC.OpenAssistantSettings]: { args: void; result: void };
  [IPC.TranscriptGet]: { args: void; result: TranscriptEntry[] };
  [IPC.TranscriptClear]: { args: void; result: void };
  [IPC.TranscriptExport]: { args: { format: 'txt' | 'md' }; result: { saved: boolean } };
  [IPC.TranscriptSetAlwaysOnTop]: { args: { value: boolean }; result: void };
  [IPC.PrefsSetAssistant]: { args: AssistantPrefsPatch; result: AssistantPrefs };
  /** Last 4 chars of the custom LLM key, never the key itself. */
  [IPC.LlmKeyGetHint]: { args: void; result: string | undefined };
  [IPC.LlmKeySet]: { args: { value: string }; result: void };
  [IPC.LlmKeyClear]: { args: void; result: void };
  [IPC.LlmTest]: { args: void; result: LlmTestResult };
  [IPC.LlmListModels]: { args: void; result: LlmModelsResult };
  [IPC.SpeakText]: { args: SpeakArgs; result: { entryId: string } };
  [IPC.SpeakStop]: { args: void; result: void };
  [IPC.SuggestNow]: { args: void; result: void };
  [IPC.SuggestionsGet]: { args: void; result: SuggestionsState };
  [IPC.SttStatusGet]: { args: void; result: SttStatus };
  [IPC.SttRetry]: { args: void; result: void };
  [IPC.AssistantContextGet]: { args: void; result: AssistantContext };
  [IPC.UsageGet]: { args: void; result: UsageSnapshot };
  [IPC.UsageReset]: { args: void; result: UsageSnapshot };
}

export interface IpcSendMap {
  [IPC.DirectionalStateChanged]: DirectionalState;
  [IPC.TranscriptDelta]: { direction: 'A' | 'B'; kind: 'input' | 'output'; text: string };
  [IPC.LatencyMeasured]: { direction: Direction; averageMs: number; sampleCount: number };
  [IPC.UpdateAvailable]: { version: string };
  [IPC.UpdateDownloaded]: { version: string };
  [IPC.HealthChanged]: HealthReport;

  // Assistant (M6)
  [IPC.TranscriptEntry]: TranscriptEntry;
  [IPC.TranscriptCleared]: void;
  [IPC.SuggestionsChanged]: SuggestionsState;
  [IPC.SttStatusChanged]: SttStatus;
  [IPC.AssistantError]: AssistantErrorEvent;
  [IPC.AssistantPrefsChanged]: AssistantPrefs;
  [IPC.AssistantContextChanged]: AssistantContext;
  [IPC.UsageChanged]: UsageSnapshot;
}
