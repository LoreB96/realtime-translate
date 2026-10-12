export const IPC = {
  // Renderer → Main (invoke)
  GetApiKeyStatus: 'config:getApiKeyStatus',
  GetApiKeyHint: 'config:getApiKeyHint',
  SetApiKey: 'config:setApiKey',
  ClearApiKey: 'config:clearApiKey',
  ListDevices: 'audio:listDevices',
  StartTranslation: 'translation:start',
  StopTranslation: 'translation:stop',

  // Prefs (Renderer → Main, invoke)
  PrefsLoad: 'prefs:load',
  PrefsSetWidgetPosition: 'prefs:setWidgetPosition',
  PrefsSetLanguages: 'prefs:setLanguages',
  PrefsSetDevices: 'prefs:setDevices',
  PrefsSetUiLanguage: 'prefs:setUiLanguage',
  PrefsSetMeetConfirmed: 'prefs:setMeetConfirmed',

  // Window management (Renderer → Main, invoke)
  OpenSetupView: 'window:openSetupView',
  SetupComplete: 'setup:complete',
  ShowBarMenu: 'window:showBarMenu',
  SetBarMouseEvents: 'bar:setMouseEvents',
  SetBarExpanded: 'bar:setExpanded',
  AppQuit: 'app:quit',
  OpenExternalUrl: 'app:openExternalUrl',

  // i18n (Renderer → Main, invoke)
  ResolveLocale: 'i18n:resolveLocale',

  // Test Translation wizard step (Renderer → Main, invoke) — M4 Phase E
  TestSessionStart: 'test:session:start',
  TestSessionInject: 'test:session:inject',
  TestSessionInputDone: 'test:session:inputDone',
  TestSessionStop: 'test:session:stop',
  LoopbackStart: 'audio:loopbackStart',
  TestRoutePlayback: 'test:routePlayback',

  // Auto-update (Renderer → Main, invoke)
  ApplyUpdate: 'app:applyUpdate',

  // Audio health + diagnostics (Renderer → Main, invoke)
  HealthGet: 'health:get',
  RunDiagnostics: 'health:runDiagnostics',
  OpenTroubleshooting: 'window:openTroubleshooting',

  // Assistant (M6) (Renderer → Main, invoke)
  OpenTranscriptView: 'window:openTranscriptView',
  OpenAssistantSettings: 'window:openAssistantSettings',
  TranscriptGet: 'transcript:get',
  TranscriptClear: 'transcript:clear',
  TranscriptExport: 'transcript:export',
  TranscriptSetAlwaysOnTop: 'transcript:setAlwaysOnTop',
  PrefsSetAssistant: 'prefs:setAssistant',
  LlmKeyGetHint: 'config:llmKeyHint',
  LlmKeySet: 'config:llmKeySet',
  LlmKeyClear: 'config:llmKeyClear',
  LlmTest: 'assistant:llmTest',
  LlmListModels: 'assistant:llmListModels',
  SpeakText: 'assistant:speak',
  SpeakStop: 'assistant:speakStop',
  SuggestNow: 'assistant:suggestNow',
  SuggestionsGet: 'assistant:suggestionsGet',
  SttStatusGet: 'assistant:sttStatusGet',
  SttRetry: 'assistant:sttRetry',
  AssistantContextGet: 'assistant:contextGet',

  // Spend tracking (Renderer → Main, invoke)
  UsageGet: 'usage:get',
  UsageReset: 'usage:reset',

  // Main → Renderer (send)
  DirectionalStateChanged: 'session:directionalStateChanged',
  TranscriptDelta: 'transcript:delta',
  LatencyMeasured: 'session:latencyMeasured',
  UpdateAvailable: 'app:updateAvailable',
  UpdateDownloaded: 'app:updateDownloaded',
  HealthChanged: 'health:changed',

  // Assistant (M6) (Main → Renderer, send)
  TranscriptEntry: 'transcript:entry',
  TranscriptCleared: 'transcript:cleared',
  SuggestionsChanged: 'assistant:suggestions',
  SttStatusChanged: 'assistant:sttStatus',
  AssistantError: 'assistant:error',
  AssistantPrefsChanged: 'assistant:prefsChanged',
  AssistantContextChanged: 'assistant:contextChanged',
  UsageChanged: 'usage:changed',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
