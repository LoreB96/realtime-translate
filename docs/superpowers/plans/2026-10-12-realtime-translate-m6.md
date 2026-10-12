# M6 Implementation Plan: Call Assistant (live transcript, typed speech, reply suggestions)

**Spec:** [`../specs/2026-10-12-realtime-translate-m6-assistant.md`](../specs/2026-10-12-realtime-translate-m6-assistant.md) (revision 2). Every unit agent reads the spec first; `§` numbers point to it.
**Predecessor:** the `main-lore` working tree. Baseline green: typecheck, lint, 243/243 tests.
**Cadence:** one agent per work unit, one commit per unit, commit messages end with the repo's usual co-author line.

## Scope cut (2026-10-12)

User decision before implementation: **M6 ships OpenAI STT plus everything else; local Whisper is deferred.** No protocol change, lower risk.

**Deferred to M7** (do not implement in M6; the M7 design stays in spec §6.2.2, §7.1 `local16k`, §7.3 and §7.5 and in U1b below as reference):

- Local Whisper STT: `whisper.worker.ts`, `whisperClient.ts`, `ortAssets.ts`, `localWhisperStt.ts`, `whisperFilter.ts`, `utteranceSegmenter.ts`, the `local16k` tap mode, `reloadWhisper` / `reloadLocalModel`, the offscreen `SttResult` / `SttStatus` IPC and their guards, `LocalSttBridge`, `onLocalSttStatus`, the `whisperModel` pref, `WhisperModel` / `WHISPER_MODELS`, the `stt-model-download-failed` error code, the `loading-model` / `ready` STT states and the `progress` / `backend` / `behind` status fields.
- Dependencies `@huggingface/transformers` and `onnxruntime-web` (no `package.json` / `package-lock.json` change in M6).
- The production `app://renderer` protocol (whole of U1b), COOP/COEP/CORP cross-origin isolation headers (dev server and packaged), the Vite `worker` / `optimizeDeps` / `assetsInclude: '**/*.wasm'` config, and the `cdn.jsdelivr.net` request block.
- Packaged-build checks of `crossOriginIsolated`, model download and model cache.

**What stays in M6:** transcript from translate deltas, `SttService` with engines `'off' | 'openai'` only, the passthrough PCM tap (`main24k` only, using the `Resampler`), typed speech + TTS (`tts` / `tts-mon` streams with playback options), LLM client + suggestions, transcript window, `#/assistant` settings, i18n. Pages keep loading from `file://` as today.

**Extension points kept for M7** (so `'local'` is an additive change): `SttEngine`, `TapMode` and `SttStatus['state']` are string unions that M7 widens; `SttService` takes `engines: Record<Exclude<SttEngine, 'off'>, SttEngineFactory>` and maps engine → tap mode through one table (`TAP_MODE_FOR_ENGINE`); `setTap` keeps its optional `TapOptions` argument (`{model, lang}`, ignored by `main24k`); the diff key keeps `model`.

**Audio utilities decision (U8a):** the `Resampler` stays: the `main24k` tap must convert the offscreen `AudioContext` rate (typically 48 kHz or 44.1 kHz) to 24 kHz for the OpenAI STT session. `UtteranceSegmenter` and `whisperFilter` are only used by the local path and are deferred.

## Ground rules for every unit

- **The plan is authoritative for signatures, file names and ownership; the spec for behaviour.** If they disagree, follow the plan and report the mismatch in your summary. Do not edit the spec.
- **Only touch the files your unit owns.** Code against the interfaces written here; never edit another unit's file. A unit that needs an interface change stops and reports it.
- **Scope cut:** read the "Scope cut" section above. Never add local-Whisper, `app://` or COOP/COEP code, even where the spec still describes it (those spec parts are marked "Deferred to M7").
- **Run before you finish:** `npm run typecheck`, `npx eslint . --ext .ts,.tsx`, `npx vitest run`. All three must be green after every unit (wave 1 is designed so this holds). `npm run build` is required from U11c on.
- **TypeScript:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Never assign `undefined` to an optional property whose type lacks `| undefined`; spread conditionally: `...(x ? { k: x } : {})`. A **required** `T | undefined` property (e.g. `ConfigStoreDeps.envApiKey`) is passed explicitly, e.g. `envApiKey: undefined`.
- **Main-process code:** no `electron` imports (not even type-only) in `src/main/{transcript,llm,tts,stt,assistant}/**`. Inject `fetch`, `wsFactory`, `now`, timers, offscreen ports, `logger`.
- **Logging:** event names and numbers only. Never pass transcript, typed, prompt or suggestion text, or an LLM response, to `logger.*`, not even under a redacted key.
- **Tests:** import from `'vitest'`, use the `@main/…`, `@shared/…`, `@renderer/…` aliases, hand-rolled fakes in the test file, `vi.useFakeTimers()` inside `try/finally`, no jsdom (renderer tests cover pure modules only).
- **Formatting:** prettier style, single quotes, semicolons, trailing commas, width 100, LF.
- **Serialization:** nothing in the assistant code calls `serialized()` except through the `serialized` dep given to `AssistantRuntime` (U11a), and `AssistantRuntime.syncAudio()` itself never calls it.

## Waves and ownership

```
WAVE 1 (parallel; disjoint files)
  U1   Contracts, prefs, IPC, handlers hook, offscreen contract, logger, build config (transcript page input)
  (U1b Production origin app:// protocol: DEFERRED to M7)
  U2   i18n keys (en-US, pt-BR, it-IT)
  U8a  Pure audio util: resampler
WAVE 2 (parallel; all depend on U1; U8b also on U8a; U9/U10 also on U2)
  U3   Transcript core            U4   LLM client, prompts, suggestions
  U5   TTS + speak controller     U6   STT services (OpenAI only)
  U7   Translate session: input transcription option
  U8b  Offscreen: main24k PCM tap, playback options (tts streams)
  U9   Transcript window UI       U10  Assistant settings UI
  U11b Transcript window module + window bounds (main, Electron)
WAVE 3
  U11a AssistantRuntime (main, no Electron; composes U3–U7)
WAVE 4
  U11c app.ts wiring
WAVE 5
  U12  Verification (build + optional packaged smoke), QA checklist, README
```

| Unit | Wave | Depends on | Owns (C = create, M = modify) |
|---|---|---|---|
| U1 | 1 | — | C `src/shared/assistant.ts`, C `src/main/util/fetchLike.ts`, C `src/main/ipc/assistantHandlers.ts`, C `src/renderer/transcript.html`, M `src/shared/events.ts`, M `src/main/ipc/channels.ts`, M `src/main/ipc/handlers.ts`, M `src/main/preload.ts`, M `src/main/config/userPrefsStore.ts`, M `src/shared/offscreenContract.ts`, M `src/main/offscreenPreload.ts`, M `src/main/util/logger.ts`, M `electron.vite.config.ts`, C `tests/unit/assistantContract.test.ts`, C `tests/unit/assistantHandlers.test.ts`, C `tests/unit/ipcHandlersHook.test.ts`, M `tests/unit/userPrefsStore.test.ts`, M `tests/unit/logger.test.ts` |
| ~~U1b~~ | — | — | **Deferred to M7** (would own C `src/main/appProtocol.ts`, the URL section of `src/main/app.ts`, C `tests/unit/appProtocol.test.ts`) |
| U2 | 1 | — | M `src/shared/i18n/locales/{en-US,pt-BR,it-IT}.json` |
| U8a | 1 | — | C `src/shared/util/resampler.ts`, C `tests/unit/resampler.test.ts` |
| U3 | 2 | U1 | C `src/main/transcript/{transcriptAssembler,transcriptStore,transcriptExport}.ts`, C `tests/unit/{transcriptAssembler,transcriptStore,transcriptExport}.test.ts` |
| U4 | 2 | U1 | C `src/main/llm/{llmErrors,sse,llmClient,prompts,suggestionParser,suggestionService}.ts`, C `tests/unit/{llmClient,sse,prompts,suggestionParser,suggestionService}.test.ts` |
| U5 | 2 | U1 | C `src/main/tts/{pcmStreamChunker,ttsService,speakController}.ts`, C `tests/unit/{pcmStreamChunker,ttsService,speakController}.test.ts` |
| U6 | 2 | U1 | C `src/main/stt/{sttTypes,openaiSttProtocol,openaiRealtimeStt,sttService,sttEntry}.ts`, C `tests/unit/{openaiSttProtocol,openaiRealtimeStt,sttService,sttEntry}.test.ts` |
| U7 | 2 | U1 | M `src/main/translate/{openaiSession,sessionManager}.ts`, M `tests/unit/openaiSession.test.ts`, M `tests/integration/sessionManager.test.ts` |
| U8b | 2 | U1, U8a | M `src/renderer/offscreen/webAudioBridge.ts`, M `src/renderer/offscreen/index.ts` |
| U9 | 2 | U1, U2 | C `src/renderer/transcript-main.tsx`, C `src/renderer/views/transcript/*`, C `src/renderer/state/{transcriptState,useTranscriptSubscription}.ts`, C `src/renderer/styles/transcript.css`, C `tests/unit/transcriptState.test.ts` |
| U10 | 2 | U1, U2 | M `src/renderer/views/setup/shared/useHashRoute.ts`, M `src/renderer/views/setup/SetupRoot.tsx`, M `src/renderer/views/setup/review/ReviewScreen.tsx`, C `src/renderer/views/setup/assistant/{AssistantScreen.tsx,assistantSummary.ts}`, M `src/renderer/styles/setup.css`, M `tests/unit/useHashRoute.test.ts`, C `tests/unit/assistantSummary.test.ts` |
| U11b | 2 | U1 | C `src/main/windows/{transcriptWindow,windowBounds}.ts`, C `tests/unit/windowBounds.test.ts` |
| U11a | 3 | U3–U7 | C `src/main/assistant/assistantRuntime.ts`, C `tests/unit/assistantRuntime.test.ts` |
| U11c | 4 | all | M `src/main/app.ts` |
| U12 | 5 | U11c | M `docs/QA-CHECKLIST.md`, M `README.md`; may fix any file (nothing runs in parallel) |

Hotspots: `app.ts` → U11c only (wave 4; U1b is deferred). `events.ts`, `channels.ts`, `handlers.ts`, `preload.ts`, `offscreenContract.ts`, `offscreenPreload.ts`, `userPrefsStore.ts`, `logger.ts`, `electron.vite.config.ts` → U1. `package*.json` → nobody (no new dependencies in M6). Locales → U2. `src/shared/i18n/types.ts` → nobody (derived from pt-BR).

---

## WAVE 1

### U1: Contracts, prefs, IPC, offscreen contract, logger, build config

**Goal:** every interface the other units code against exists and typechecks; the app builds and runs exactly as before.

#### U1.1 `src/shared/assistant.ts` (pure)

Export verbatim everything in spec §5 and §5.1 (M6 shapes, i.e. without the parts marked "Deferred to M7"): `Speaker`, `TranscriptSource`, `TranscriptEntry`, `SpeakStatus`, `Suggestion`, `SuggestionsState`, `AssistantErrorCode`, `SttStatus`, `AssistantContext`, `SpeakArgs`, `SttEngine` (`'off' | 'openai'`), `LlmPreset`, `ReasoningEffort`, `AssistantPrefs`, `TranscriptWindowPrefs`, `LLM_PRESETS`. No `WhisperModel`, no `whisperModel` pref (both M7). Import `Direction` from `./types`, `LanguageCode` from `./languages`.

```ts
export type AssistantPrefsPatch = Partial<Omit<AssistantPrefs, 'llm'>> & { llm?: Partial<AssistantPrefs['llm']> };
export type StoredAssistantPrefs = AssistantPrefsPatch;
export type AssistantErrorScope = 'speak' | 'suggest' | 'stt' | 'llm';

export const DEFAULT_ASSISTANT_PREFS: AssistantPrefs = { sttEngine: 'off', sttOpenAiModel: 'gpt-4o-mini-transcribe',
  translateInputTranscript: false, translateTheirSpeech: false,
  llm: { preset: 'openai', ...LLM_PRESETS.openai }, ttsVoice: 'alloy', ttsModel: 'gpt-4o-mini-tts',
  ttsMonitor: false, suggestionsEnabled: true, autoSuggest: true, transcriptOpenOnLaunch: false };
export const DEFAULT_TRANSCRIPT_WINDOW: TranscriptWindowPrefs = { width: 420, height: 640, alwaysOnTop: false };
export const STT_ENGINES: readonly SttEngine[] = ['off', 'openai']; // M7 appends 'local'
export const STT_OPENAI_MODELS = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'gpt-live-transcribe'] as const;
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['', 'none', 'minimal', 'low', 'medium', 'high'];
export const TTS_VOICES = ['alloy','ash','ballad','coral','echo','fable','onyx','nova','sage','shimmer','verse','marin','cedar'] as const;
export const MAX_SPEAK_CHARS = 2000;
export const MAX_TTS_INPUT_CHARS = 4096;
export const ASSISTANT_ERROR_CODES: readonly AssistantErrorCode[]; // all 14 codes of §5 (no 'stt-model-download-failed' in M6)

export function resolveAssistantPrefs(p: StoredAssistantPrefs | undefined): AssistantPrefs; // never throws
export function mergeAssistantPrefs(base: StoredAssistantPrefs | undefined, patch: AssistantPrefsPatch): StoredAssistantPrefs; // deep-merges llm
export function isAssistantPrefsPatch(v: unknown): v is AssistantPrefsPatch; // unknown keys rejected
export function isSpeakArgs(v: unknown): v is SpeakArgs;        // text 1..2000 after trim; translate boolean; translation? ≤ 4096
export function isExportArgs(v: unknown): v is { format: 'txt' | 'md' };
export function isLlmKeyArgs(v: unknown): v is { value: string }; // 1..300 chars
export function isAlwaysOnTopArgs(v: unknown): v is { value: boolean };
export function isReasoningEffort(v: unknown): v is ReasoningEffort;
export function isOpenAiHost(baseUrl: string): boolean;   // protocol 'https:' AND hostname 'api.openai.com' AND port '' | '443'
export function isLoopbackHost(baseUrl: string): boolean; // localhost, 127.0.0.1, [::1]
export function isValidBaseUrl(s: string): boolean;       // URL parse, http/https, ≤ 200 chars
/** Security: never returns openAiKey unless isOpenAiHost(baseUrl). */
export function selectLlmKey(baseUrl: string, openAiKey: string | undefined, customKey: string | undefined): string | undefined;
export function speakerOf(d: Direction): Speaker;         // A→'me', B→'them'
export function countWords(text: string): number;          // whitespace split; each CJK char counts as a word
/** Spec §6.1 joining: one space unless prev empty/ends in whitespace, delta starts with whitespace or ,.;:!?…)]}'" , or either side is CJK. Used by U3 and U6. */
export function joinDelta(prev: string, delta: string): string;
```

`selectLlmKey`: OpenAI host → `openAiKey ?? customKey`; otherwise → `customKey`.

`resolveAssistantPrefs` validates `sttEngine` against `STT_ENGINES`, so any other value (e.g. a future `'local'` read by an M6 build) falls back to `'off'`; stray stored keys such as `whisperModel` are ignored, never thrown on.

#### U1.2 `src/main/util/fetchLike.ts`

```ts
export interface FetchResponseLike {
  ok: boolean; status: number;
  json(): Promise<unknown>; text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}
export type FetchLike = (url: string, init: {
  method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal?: AbortSignal;
}) => Promise<FetchResponseLike>;
export const nodeFetch: FetchLike = (url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>;
```

#### U1.3 `src/main/config/userPrefsStore.ts`

- `UserPrefs` gains `assistant?: StoredAssistantPrefs` and `transcriptWindow?: TranscriptWindowPrefs`.
- `setAssistant(patch: AssistantPrefsPatch): AssistantPrefs`: load, `mergeAssistantPrefs`, save, return `resolveAssistantPrefs(merged)`.
- `setTranscriptWindow(p: Partial<TranscriptWindowPrefs>): void`: shallow-merge over the stored value or `DEFAULT_TRANSCRIPT_WINDOW`.

#### U1.4 `src/shared/events.ts`

Add every constant of spec §8: 19 invoke (under `// Assistant (M6)`) and 7 send, with the exact channel strings.

#### U1.5 `src/main/ipc/channels.ts`

`IpcInvokeMap` / `IpcSendMap` entries for every new channel with the §8 args/results (`TranscriptCleared` is `void`; `AssistantError` is `{ scope: AssistantErrorScope; code: AssistantErrorCode }`). Types from `../../shared/assistant`.

#### U1.6 `src/main/ipc/handlers.ts` (hook only)

- `HandlerDeps` gains `onPrefsChanged?: (what: 'languages' | 'devices' | 'apiKey') => void`.
- `PrefsSetLanguages` → after `setLanguages` returns, `deps.onPrefsChanged?.('languages')`. Same for `PrefsSetDevices` (`'devices'`), `SetApiKey` and `ClearApiKey` (`'apiKey'`). Return values unchanged; the hook runs only when the write did not throw. The hook is fire-and-forget (its return value ignored).
- No other change. (The `handle` wrapper is at about lines 66-74.)

#### U1.7 `src/main/preload.ts`

Invoke methods (typed promises):

| Method | Channel |
|---|---|
| `openTranscriptView()` | `OpenTranscriptView` |
| `openAssistantSettings()` | `OpenAssistantSettings` |
| `getTranscript()` | `TranscriptGet` |
| `clearTranscript()` | `TranscriptClear` |
| `exportTranscript(format)` | `TranscriptExport` `{format}` |
| `setTranscriptAlwaysOnTop(value)` | `TranscriptSetAlwaysOnTop` `{value}` |
| `setAssistantPrefs(patch)` | `PrefsSetAssistant` |
| `getLlmKeyHint()` / `setLlmKey(value)` / `clearLlmKey()` | `LlmKeyGetHint` / `LlmKeySet` `{value}` / `LlmKeyClear` |
| `testLlm()` / `listLlmModels()` | `LlmTest` / `LlmListModels` |
| `speakText(args)` / `stopSpeaking()` | `SpeakText` / `SpeakStop` |
| `suggestNow()` / `getSuggestions()` | `SuggestNow` / `SuggestionsGet` |
| `getSttStatus()` / `retryStt()` | `SttStatusGet` / `SttRetry` |
| `getAssistantContext()` | `AssistantContextGet` |

Subscriptions (`onX(cb) → unsubscribe`): `onTranscriptEntry`, `onTranscriptCleared` (no args), `onSuggestions`, `onSttStatus`, `onAssistantError`, `onAssistantPrefs`, `onAssistantContext`.

#### U1.8 `src/main/ipc/assistantHandlers.ts`

```ts
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
export type LlmTestResult = { ok: true; ms: number } | { ok: false; code: AssistantErrorCode };
export type LlmModelsResult = { ok: true; models: string[] } | { ok: false; code: AssistantErrorCode };
export interface AssistantHandlerDeps {
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
  openTranscriptView: () => Promise<void>;
  openAssistantSettings: () => Promise<void>;
  getTranscript: () => TranscriptEntry[];
  clearTranscript: () => void;
  exportTranscript: (format: 'txt' | 'md', sender: WebContents) => Promise<{ saved: boolean }>;
  setTranscriptAlwaysOnTop: (value: boolean) => void;
  setAssistantPrefs: (patch: AssistantPrefsPatch) => Promise<AssistantPrefs>;
  getLlmKeyHint: () => string | undefined;
  setLlmKey: (value: string) => void;
  clearLlmKey: () => void;
  testLlm: () => Promise<LlmTestResult>;
  listLlmModels: () => Promise<LlmModelsResult>;
  speakText: (a: SpeakArgs) => { entryId: string };
  stopSpeaking: () => void;
  suggestNow: () => Promise<void>;
  getSuggestions: () => SuggestionsState;
  getSttStatus: () => SttStatus;
  retryStt: () => Promise<void>;
  getAssistantContext: () => AssistantContext;
}
export function registerAssistantIpcHandlers(ipcMain: Pick<IpcMain, 'handle'>, deps: AssistantHandlerDeps): void;
```

- Copy the `handle<K>` wrapper of `handlers.ts` (trusted-sender check first, then the handler).
- Validate with the U1.1 guards; throw `new Error('invalid-args')` on failure (`isPrefsPatch`, `isSpeakArgs`, `isExportArgs`, `isLlmKeyArgs`, `isAlwaysOnTopArgs`).
- Nothing calls it until U11c.

#### U1.9 `src/shared/offscreenContract.ts`

Keep existing members unchanged. Add:

```ts
export type TapMode = 'off' | 'main24k';                  // M7 adds 'local16k'
/** Reserved for engines that need it (M7 local); the main24k tap ignores it. */
export interface TapOptions { model?: string; lang?: string }
export interface PlaybackOptions { maxBacklogS?: number; catchup?: boolean }
/** Shape of window.offscreenBridge (offscreenPreload implements it, offscreen/index.ts declares it). */
export interface OffscreenPreloadBridge {
  onPushPlayback(handler: (streamId: string, base64: string) => void): void;
  sendPcm(streamId: string, base64: string): void;
  sendLevel(report: LevelReport): void;
  sendStreamEvent(e: StreamEvent): void;
  sendDeviceChange(): void;
}
/** Extra offscreen window API, implemented by U8b. */
export interface OffscreenAssistantApi {
  /** Stores the tap and applies it; MUST resolve immediately (never awaits anything slow). */
  setPassthroughTap(streamId: string, mode: TapMode, opts?: TapOptions): Promise<void>;
  startPlaybackWithOptions(streamId: string, outDeviceId: string, opts: PlaybackOptions): Promise<void>;
}
```

Check the existing preload bridge shape against `OffscreenPreloadBridge` before writing it; adapt the members to match today's code exactly. **Deferred to M7:** `OFFSCREEN_IPC.SttResult` / `SttStatus`, `SttResultMsg`, `SttWorkerStatusMsg`, `isSttResult`, `isSttWorkerStatusMsg`, `sendSttResult` / `sendSttStatus`, `reloadWhisper`.

#### U1.10 `src/main/offscreenPreload.ts`

Type the exposed object as `OffscreenPreloadBridge` (no new members in M6; the `main24k` tap reuses the existing `sendPcm`).

#### U1.11 `src/main/util/logger.ts`

Extend `REDACTED_FIELDS` with `text`, `original`, `translated`, `content`, `messages`, `prompt`, `instructions`, `suggestions`, `items`, `choices`, `input`. First run `grep -rn "logger\.\(info\|warn\|error\|debug\)" src/main` and confirm none is used for non-content data; if one is, rename that call site's key and report it.

#### U1.12 Dependencies

None in M6. Do not touch `package.json` / `package-lock.json`. (`@huggingface/transformers` and `onnxruntime-web` are deferred to M7.)

#### U1.13 Build config

- `src/renderer/transcript.html`: copy of `setup-view.html`, `<title>Live transcript</title>`, script `./transcript-main.tsx` (created by U9).
- `electron.vite.config.ts` renderer section: add only the input `transcript: resolve('src/renderer/transcript.html')`. **Deferred to M7:** `worker: { format: 'es' }`, `optimizeDeps.exclude`, `assetsInclude: ['**/*.wasm']`, and the dev-server COOP/COEP/CORP headers.
- `npm run build` fails until U9 lands (missing `transcript-main.tsx`); typecheck and tests are unaffected.

#### U1 tests

- `assistantContract.test.ts`: defaults; invalid enum (incl. `sttEngine: 'local'` → `'off'`) / bad URL / oversize model / bad reasoning effort dropped; deep merge; every guard accept/reject (`isSpeakArgs` empty, 2001 chars, non-boolean translate, translation 4097); `isAssistantPrefsPatch` rejects unknown keys and `file:///x`; `isOpenAiHost`: `https://api.openai.com/v1` true, `http://api.openai.com/v1` false, `https://api.openai.com:8443/v1` false, `https://api.openai.com.evil.io` false; `selectLlmKey` for `http://127.0.0.1:11434/v1` → custom, `https://api.openai.com/v1` → openai, `http://api.openai.com/v1` with `('sk-x', undefined)` → `undefined`, `https://evil.example/v1` with `('sk-x','k')` → `'k'`; `countWords`; `joinDelta` (`'Hello'+'world'`, `'Hello'+', world'`, trailing-space prev, CJK).
- (`offscreenContract.test.ts` is deferred to M7 with the guards it would test; M6 adds only types to `offscreenContract.ts`.)
- `assistantHandlers.test.ts`: fake `ipcMain.handle` collecting handlers; all 19 channels registered; untrusted sender throws before the dep is called; invalid args throw `invalid-args`; valid args reach the dep.
- `ipcHandlersHook.test.ts`: with fake deps and a fake `ipcMain` (mock the `electron` module with `vi.mock('electron', …)` as the existing handler tests do, if any; otherwise inject), the hook fires once after each of the 4 writes and not when the write throws. If `handlers.ts` cannot be tested without Electron, test it the same way existing tests import it, and report.
- `userPrefsStore.test.ts`: `setAssistant({llm:{model:'m'}})` keeps other `llm` fields and returns resolved prefs; `setTranscriptWindow` merges.
- `logger.test.ts`: `{text:'secret', original:'x', count:2}` → line has `count`, not `secret`.

---

### U1b: Production origin (`app://renderer`) — DEFERRED to M7

> **Not implemented in M6** (scope cut). No agent runs this unit; `app.ts` keeps its `file://` URLs and `isAppUrl` unchanged, and nothing in M6 imports `appProtocol.ts`. The text below is kept only as the M7 reference design; it is needed solely for local Whisper (fetch of bundled WASM, Cache API model cache, multithreaded WASM).

**Goal (M7):** packaged pages load from a privileged standard scheme so `fetch`, the Cache API, workers and cross-origin isolation work (spec §7.5). Dev behaviour is unchanged (dev server URL).

#### `src/main/appProtocol.ts`

```ts
import type { Protocol } from 'electron';
export const APP_SCHEME = 'app';
export const APP_HOST = 'renderer';
export const APP_ORIGIN = 'app://renderer';
export const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp', // fallback 'credentialless' if HF downloads fail (U12)
  'Cross-Origin-Resource-Policy': 'same-origin',
};
/** Must run at module load, before app 'ready'. */
export function registerAppSchemePrivileged(protocol: Pick<Protocol, 'registerSchemesAsPrivileged'>): void;
/** Pure: maps app://renderer/<path> to an absolute file under rootDir, or undefined (other host, traversal, encoded '..', backslashes, empty → 'index' not served). */
export function resolveAppRequestPath(url: string, rootDir: string): string | undefined;
/** Pure: page URL for production. */
export function appPageUrl(page: string): string; // `${APP_ORIGIN}/${page}`
/** Pure: our page? devBase = ELECTRON_RENDERER_URL or undefined. */
export function isAppPageUrl(raw: string, devBase: string | undefined): boolean;
/** Installs protocol.handle: net.fetch(pathToFileURL(file)) then re-wraps the Response adding ISOLATION_HEADERS; 404 when unresolved or missing. */
export function installAppProtocol(protocol: Pick<Protocol, 'handle'>, rootDir: string, netFetch: (url: string) => Promise<Response>): void;
```

`isAppPageUrl`: in dev, same origin as `devBase`; in production, `url.origin === APP_ORIGIN` (for a standard scheme `new URL('app://renderer/x').origin` is `'app://renderer'` in Electron; in Node tests compare `protocol` + `host` instead of `origin`, since Node returns `'null'` for unknown schemes).

#### `src/main/app.ts` (only these edits)

- Call `registerAppSchemePrivileged(protocol)` at module top level (after imports).
- Production `FLOATING_WIDGET_URL`, `SETUP_VIEW_URL`, `OFFSCREEN_URL` use `appPageUrl('<page>.html')`; dev unchanged.
- `isAppUrl(raw)` becomes `isAppPageUrl(raw, DEV_BASE)`; remove the now-unused `file:` branch (keep `RENDERER_DIR` as the protocol root).
- In `app.whenReady()`, before `createWindows`, when `!DEV_BASE`: `installAppProtocol(protocol, RENDERER_DIR, (u) => net.fetch(u))`.
- Leave a `// U11c:` comment where the jsdelivr block will go (§9).

#### Tests: `appProtocol.test.ts`

`resolveAppRequestPath`: normal file, nested asset, query/hash ignored, `..` and `%2e%2e` rejected, backslash rejected, other host rejected; `isAppPageUrl` dev and prod cases, `file://` rejected in prod; `appPageUrl`.

#### Manual check

`npm run build && npx electron-vite preview` (or `npm run dist` and run `release/win-unpacked`): bar, setup and passthrough work; the offscreen devtools console shows `crossOriginIsolated === true`. Report the result.

---

### U2: i18n keys

Add to all three locales with identical structure and placeholders; translate faithfully into pt-BR and it-IT (same tone as the existing files); no empty values. pt-BR is the type source; `tests/unit/i18n.test.ts` must stay green.

```jsonc
// "menu":
"transcript": "Live transcript",

// "review.section":
"assistant": "Assistant: transcript, AI, voice",
"assistantValue": "Transcription: {{stt}} · AI: {{llm}}",

"transcript": {
  "title": "Live transcript",
  "status": {
    "translating": "Translating — transcript from the translation",
    "sttOpenai": "Direct audio — transcribing with OpenAI",
    "off": "Transcription is off while not translating",
    "error": "Transcription problem — check Assistant settings",
    "retry": "Retry"
  },
  "cta": {
    "title": "Turn on transcription to see the call when you're not translating.",
    "openai": "Transcribe with OpenAI",
    "hint": "About $0.003 per minute of speech; silence is not sent."
  },
  "speaker": { "me": "Me", "them": "Them" },
  "empty": "Nothing yet. What is said in the call will appear here.",
  "jumpToLatest": "Jump to latest",
  "pin": "Keep on top",
  "unpin": "Stop keeping on top",
  "menu": {
    "more": "More",
    "clear": "Clear transcript",
    "clearConfirm": "Clear",
    "exportTxt": "Export as text",
    "exportMd": "Export as Markdown",
    "settings": "Assistant settings"
  },
  "confirmClear": "Clear the whole transcript? This cannot be undone.",
  "typed": "Typed",
  "speak": {
    "queued": "Waiting…",
    "translating": "Translating…",
    "synthesizing": "Preparing voice…",
    "speaking": "Speaking…",
    "done": "Spoken",
    "error": "Couldn't speak this",
    "cancelled": "Stopped",
    "retry": "Retry"
  },
  "composer": {
    "placeholder": "Type what you want to say…",
    "send": "Speak",
    "stop": "Stop",
    "translate": "Translate to {{lang}} before speaking",
    "charCount": "{{n}}/{{max}}",
    "noKey": "Typed speech needs an OpenAI API key.",
    "noDevice": "Choose the “Output to call” device in Settings first.",
    "setupBusy": "Close the setup screens to speak into the call."
  },
  "suggestions": {
    "title": "Suggested replies",
    "suggest": "Suggest",
    "loading": "Thinking…",
    "empty": "No suggestions right now.",
    "needsStt": "Turn on transcription so suggestions can follow the call when you're not translating.",
    "speak": "Speak",
    "edit": "Edit",
    "hide": "Hide",
    "show": "Show"
  },
  "export": { "header": "Transcript — {{date}}" }
},

"assistant": {
  "heading": "Assistant",
  "sub": "Live transcript, typed speech and reply suggestions.",
  "stt": {
    "title": "Live transcript",
    "engine": "Transcription when not translating",
    "off": "Off",
    "openai": "OpenAI (cloud)",
    "openaiModel": "OpenAI model",
    "costOpenai": "Billed per minute of speech; silence is not sent.",
    "inputTranscript": "Also transcribe the original speech while translating",
    "inputTranscriptHint": "May add about $0.017 per minute for each direction. Applies from the next Start.",
    "theirSpeech": "Translate what the other person says when not translating",
    "theirSpeechHint": "Uses the AI model below, one short request per sentence.",
    "openOnLaunch": "Open the transcript window when the app starts",
    "openNow": "Open transcript",
    "retry": "Retry",
    "state": {
      "off": "Off",
      "listening": "Listening",
      "error": "Error"
    }
  },
  "llm": {
    "title": "AI model",
    "preset": "Provider",
    "openai": "OpenAI",
    "ollama": "Ollama",
    "lmstudio": "LM Studio",
    "custom": "Custom",
    "baseUrl": "Server address (base URL)",
    "model": "Model",
    "loadModels": "Load models",
    "modelsEmpty": "The server returned no models.",
    "modelsFailed": "Couldn't load the model list.",
    "reasoning": "Reasoning effort",
    "reasoningDefault": "Server default",
    "reasoningHint": "Leave on “Server default” if your model doesn't support it.",
    "apiKey": "API key (optional)",
    "apiKeyHint": "Stored encrypted on this PC. Your OpenAI key is never sent to other servers.",
    "apiKeySaved": "Saved key ●●●●{{last4}}",
    "apiKeySave": "Save key",
    "apiKeyClear": "Remove key",
    "openaiKeyUsed": "Uses your OpenAI API key.",
    "test": "Test connection",
    "testOk": "Connected — {{ms}} ms",
    "hintOllama": "Is Ollama running? Start it, then run “ollama pull {{model}}”.",
    "cost": "OpenAI: about $0.001–0.004 per suggestion. Local models are free.",
    "insecureWarn": "This address isn't encrypted: transcripts would travel over the network in clear text."
  },
  "tts": {
    "title": "Voice for typed messages",
    "voice": "Voice",
    "monitor": "Also play it on my headset",
    "monitorWarn": "Only with headphones — on speakers the microphone picks it up and the call hears it twice.",
    "cost": "Uses OpenAI text-to-speech: a short message costs a fraction of a cent."
  },
  "suggest": {
    "title": "Reply suggestions",
    "enabled": "Show reply suggestions",
    "auto": "Suggest automatically after the other person speaks",
    "hint": "Uses the AI model above. The recent transcript is sent to it."
  },
  "errors": {
    "no-openai-key": "This needs an OpenAI API key.",
    "llm-unreachable": "Can't reach the AI server. If you use Ollama or LM Studio, make sure it is running.",
    "llm-auth": "The AI server rejected the API key.",
    "llm-model-missing": "Model not found on the AI server. Choose or download a model.",
    "llm-timeout": "The AI server took too long to answer.",
    "llm-bad-response": "The AI answer couldn't be read.",
    "llm-truncated": "The AI answer was cut off. Try a lower reasoning effort.",
    "tts-failed": "Couldn't generate the voice.",
    "tts-no-device": "No “Output to call” device is configured.",
    "tts-busy-setup": "The setup screens are using the audio devices. Close them and try again.",
    "stt-failed": "Transcription service error.",
    "input-transcript-unsupported": "The translation service didn't accept original-speech transcription. Translation continues normally.",
    "rate-limited": "Too many requests — wait a moment and retry.",
    "unknown": "Something went wrong."
  }
}
```

The `ConfirmModal` uses the existing `common.cancel` and `transcript.menu.clearConfirm`.

Scope cut: no local-Whisper strings in M6 (`transcript.status.sttLocal|loadingModel|behind`, `transcript.cta.local`, `assistant.stt.local|localModel|auto|modelBase|modelSmall|modelTurbo|turboWarn|costLocal|behind`, `assistant.stt.state.loading-model|ready`, `assistant.errors.stt-model-download-failed`). M7 adds them. Every `assistant.errors.*` key matches exactly one `AssistantErrorCode` (14).

**Test:** `npx vitest run tests/unit/i18n.test.ts` and `npm run typecheck`.

---

### U8a: Pure audio utility (resampler)

Scope cut: only the `Resampler` is built in M6, because the `main24k` OpenAI tap needs `ctx.sampleRate → 24000`. `UtteranceSegmenter` and `whisperFilter` serve only the local Whisper path and are **deferred to M7** (their design stays in spec §7.1 / §7.3).

#### `src/shared/util/resampler.ts`

```ts
export class Resampler {
  constructor(fromRate: number, toRate: number, taps?: number /* default 64 */);
  /** Resampled samples for this block (length varies); state kept across calls. */
  process(input: Float32Array): Float32Array;
}
```

- `fromRate === toRate` → copy.
- Otherwise a Blackman-windowed sinc low-pass FIR, `taps` taps, normalized cutoff `0.4 * min(from, to) / from`, with a history ring; then linear interpolation at a fractional read position advancing by `from / to` per output sample, carried across blocks.
- Long-run output length = `floor(totalIn * to / from) ± 1`.
- Generic in `toRate` (M7 reuses it for 16 kHz), but M6 tests target 24 kHz.

#### Tests

- resampler: 48k→24k and 44.1k→24k over 100 random-sized blocks within ±1 of ideal; 1 kHz sine RMS within 1 dB after 48k→24k (skip the first 64 output samples); 14 kHz sine at 48k→24k (above the 12 kHz output Nyquist) attenuated ≥ 20 dB; identity (24k→24k copy).

---

## WAVE 2 (parallel)

### U3: Transcript core

Text joining uses `joinDelta` from `@shared/assistant` (U1).

#### `transcriptAssembler.ts`

```ts
export const FINALIZE_IDLE_MS = 1800;
export const OUTPUT_LAG_MS = 4000;
export const LONG_ENTRY_MS = 30000;
export const LATE_OUTPUT_MS = 3000;
export interface AssemblerDeps { now: () => number; langs: () => { user: LanguageCode; them: LanguageCode } }
export class TranscriptAssembler {
  constructor(deps: AssemblerDeps);
  /** Returns the created/updated entry copy, or undefined for an empty/whitespace delta with nothing to return. */
  onTranslateDelta(d: { direction: Direction; kind: 'input' | 'output'; text: string }): TranscriptEntry | undefined;
  /** Applies idle rules; returns entries that changed. */
  tick(): TranscriptEntry[];
  finalizeAll(): TranscriptEntry[];
}
```

- State per direction: `{ entry, lastInputAt?: number, lastOutputAt?: number }` for the open entry, plus `lastFinal?: { entry, finalizedAt }`. A single `seq` counter, never reset. Ids `tr-${direction}-${seq}`.
- New entry: `speaker = speakerOf(direction)`; A: `originalLang = user`, `translatedLang = them`; B reversed; `final: false`; `startedAt = updatedAt = now`.
- Late output: an `output` delta with no open entry attaches to `lastFinal.entry` when `now − finalizedAt < LATE_OUTPUT_MS` and its `translated === ''`; returns the updated (still final) copy.
- Finalize rules exactly as spec §6.1 (idle with "waiting for output" exception; long entry on `translated` punctuation with input idle ≥ 1800 ms; `finalizeAll`).
- The long-entry check runs in `onTranslateDelta` and in `tick`.

#### `transcriptStore.ts`

```ts
export interface TranscriptStoreDeps {
  now: () => number;
  onUpsert: (e: TranscriptEntry) => void;
  onCleared: () => void;
  onFinal?: (e: TranscriptEntry) => void;
  maxEntries?: number; // 500
}
export class TranscriptStore {
  constructor(deps: TranscriptStoreDeps);
  upsert(e: TranscriptEntry): void;   // replace by id or append; fires onFinal once when final first becomes true
  patch(id: string, p: Partial<Omit<TranscriptEntry, 'id'>>): TranscriptEntry | undefined; // sets updatedAt; calls onUpsert; may fire onFinal
  get(id: string): TranscriptEntry | undefined;  // copy
  snapshot(): TranscriptEntry[];      // oldest → newest, copies
  recent(opts: { maxEntries: number; maxChars: number; finalOnly?: boolean }): TranscriptEntry[];
  clear(): void;
}
```

Ring eviction drops the oldest; the `onFinal` id set is pruned on eviction and cleared on `clear()`. `recent` rules as spec §6.1.

#### `transcriptExport.ts`

`formatTranscript(entries, opts: { format: 'txt' | 'md'; t: T; date: Date; tz?: string }): string` — header `t('transcript.export.header', {date: date.toLocaleDateString('en-GB', {timeZone: tz})})`; times `toLocaleTimeString('en-GB', {hour12:false, timeZone: tz})`; one line per entry with text; Markdown bold speakers and `# ` header.

#### Tests

Assembler: A input+output merge; joining; idle finalize at exactly 1800 ms; **output lagging input by 2.5 s stays in the same entry**; **2.5 s output lag across a 30 s boundary does not split**; late output attach within 3 s and not after; long-entry finalize; A/B independent; `finalizeAll`; languages; ids never reused after `finalizeAll`.
Store: replace by id, ring eviction, `onFinal` once (also via `patch`), `get`, `patch`, `recent` limits/order/skip-empty, `clear`.
Export: txt and md with `tz: 'UTC'`, `createT(getDictionary('en-US'))`.

---

### U4: LLM client, prompts, suggestions

#### `llmErrors.ts`

```ts
export class LlmError extends Error { constructor(readonly code: AssistantErrorCode, readonly status?: number) { super(code); this.name = 'LlmError'; } }
export function mapHttpError(status: number, bodyText: string): AssistantErrorCode;
export function mapThrown(err: unknown, timedOut: boolean): AssistantErrorCode; // see spec §6.3; checks err.cause?.code too
export function isAbortError(err: unknown): boolean;
```

#### `sse.ts`

`parseSseChunk(buffer: string): { events: string[]; rest: string }` — `\n` / `\r\n`, `data:` lines, comments and blanks ignored, incomplete trailing line in `rest`, `[DONE]` passed through.

#### `llmClient.ts`

```ts
export interface LlmConfig { baseUrl: string; model: string; apiKey?: string; reasoningEffort: ReasoningEffort }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface CompleteOpts {
  messages: ChatMessage[]; maxTokens: number;
  jsonSchema?: { name: string; schema: object };
  signal?: AbortSignal;
  timeoutMs?: number; // default: 30000 for an OpenAI host, 90000 otherwise
}
export function buildChatBody(cfg: LlmConfig, o: Pick<CompleteOpts, 'messages' | 'maxTokens' | 'jsonSchema'>, stream: boolean, omit?: { schema?: boolean; reasoning?: boolean }): Record<string, unknown>;
export function stripThink(s: string): string;
export function filterOpenAiChatModels(ids: string[]): string[];
export class LlmClient {
  constructor(deps: { fetch: FetchLike; config: () => LlmConfig; logger?: Logger; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout; now?: () => number });
  complete(o: CompleteOpts): Promise<string>;
  stream(o: CompleteOpts, onDelta: (t: string) => void): Promise<string>;
  listModels(signal?: AbortSignal): Promise<string[]>;
}
```

- URL `cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'`. Headers `Content-Type`, plus `Authorization: Bearer` only with a key.
- Empty `cfg.model.trim()` → throw `LlmError('llm-model-missing')` before fetch.
- Timeout via internal `AbortController` + injected timer; caller signal chained; caller abort rethrows a `DOMException('AbortError')`-like error (`name === 'AbortError'`); timeout → `LlmError('llm-timeout')`.
- Non-ok: read `text()`. Retry once without the schema on 400 + `/response_format|json_schema/i` (when sent); retry once without `reasoning_effort` on 400 + `/reasoning|think/i` (when sent). Both retries may happen in one call (max 3 requests). Else `LlmError(mapHttpError(status, text), status)`.
- Content: `choices[0].finish_reason === 'length'` → `LlmError('llm-truncated')`; non-string content → `llm-bad-response`; `stripThink(content).trim()` empty → `llm-bad-response`.
- `stream()`: `stream: true`, `getReader()` + `TextDecoder`, `parseSseChunk`, `choices[0].delta.content`, stop at `[DONE]`; `finish_reason: 'length'` in a chunk → `llm-truncated`; returns stripped full text (empty → `llm-bad-response`).
- `listModels()`: `GET {base}/models`, `data[].id`, sorted; `filterOpenAiChatModels` applied when `isOpenAiHost`.
- Logging: `llm_request_done {status, ms, model, finish}`, `llm_request_failed {code, status}`, `llm_retry {reason: 'schema' | 'reasoning'}`.

#### `prompts.ts`

```ts
export function languageName(code: LanguageCode): string;
export function buildTranslatePrompt(text: string, from: LanguageCode, to: LanguageCode): ChatMessage[];
export function buildSuggestionPrompt(entries: TranscriptEntry[], langs: { user: LanguageCode; them: LanguageCode }): ChatMessage[];
export const SUGGESTION_SCHEMA: { name: 'reply_suggestions'; schema: object };
export const SUGGEST_MAX_TOKENS = 2000;
export const TEST_MAX_TOKENS = 512;
export function translateMaxTokens(chars: number): number; // Math.min(6000, Math.ceil(chars / 2) + 1000)
/** Convenience used by U11a (speech + their-speech translation). */
export function translateWith(llm: Pick<LlmClient, 'complete'>, text: string, from: LanguageCode, to: LanguageCode, signal?: AbortSignal): Promise<string>;
```

Prompt texts exactly as spec §6.3; schema as before (`suggestions` array, `maxItems: 3`, items `{text, translation}`, `additionalProperties: false`). Transcript lines: `Them: translated || original`, `Me: original || translated`, bounded 30 entries / 6000 chars from the oldest.

#### `suggestionParser.ts`

`parseSuggestions(raw: string): Suggestion[]` per spec §6.3 (fence strip, JSON, brace scan, list lines `/^\s*(?:\d+[.)]|[-*•])\s+(.+)$/`, bare string array, trim, drop empty text, max 3).

#### `suggestionService.ts`

```ts
export interface SuggestionServiceDeps {
  llm: Pick<LlmClient, 'complete'>;
  recent: () => TranscriptEntry[];
  langs: () => { user: LanguageCode; them: LanguageCode };
  enabled: () => { suggestions: boolean; auto: boolean };
  onState: (s: SuggestionsState) => void;
  now: () => number;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
  debounceMs?: number;          // 1200
  questionDebounceMs?: number;  // 300
  logger?: Logger;
}
export class SuggestionService {
  constructor(deps: SuggestionServiceDeps);
  onFinalEntry(e: TranscriptEntry): void;
  requestNow(): Promise<void>;
  cancel(): void;
  state(): SuggestionsState;
}
```

- Run: `++seq`, new `AbortController`, state `loading`, `llm.complete({messages: buildSuggestionPrompt(recent(), langs()), maxTokens: SUGGEST_MAX_TOKENS, jsonSchema: SUGGESTION_SCHEMA, signal})`, `parseSuggestions`, `ready` (only if `seq` current). `LlmError` → `error` with its code; abort ignored; other → `unknown`.
- `onFinalEntry`: ignore when `!enabled().suggestions`. `them`: requires `auto` and `countWords(translated || original) ≥ 2`; debounce `questionDebounceMs` if that text ends in `?`/`？`, else `debounceMs`; restarting the timer on each trigger. `me`: if `source !== 'typed'`, `countWords(original || translated) ≥ 2` and state `ready` → `idle`.
- `requestNow`: cancels the timer, runs immediately if suggestions are enabled.
- `cancel`: abort, clear timer, `idle`.

#### Tests

llmClient: body per host (`max_completion_tokens`, no temperature on OpenAI; `max_tokens` + temperature elsewhere); `reasoning_effort` present only when non-empty; header only with a key; schema retry; reasoning retry; both retries; 401/404/429/TypeError/timeout mapping; per-host default timeout (fake timers: 30 s vs 90 s); empty model throws before fetch; `finish_reason: 'length'` → `llm-truncated`; empty content after think-strip → `llm-bad-response`; think-strip; `stream()` with mid-line splits; `listModels` sorting + OpenAI filter.
sse, prompts (`translateMaxTokens` values, language names, line format), parser (JSON, fenced, prose-wrapped, numbered list, garbage → `[]`, cap 3).
suggestionService: debounce 1200; `?` → 300; new trigger aborts old; stale result ignored; one-word `them` ignored; `me` voice entry clears `ready`; typed `me` does not; `me` one-word does not; disabled; errors.

---

### U5: TTS + speak controller

#### `pcmStreamChunker.ts`

```ts
export const TTS_SAMPLE_RATE = 24000;
export const CHUNK_BYTES = 4800;
export class PcmStreamChunker {
  push(bytes: Uint8Array): string[];  // base64 chunks of exactly CHUNK_BYTES (Buffer)
  flush(): string | undefined;        // remaining bytes rounded down to even length
  get totalSamples(): number;
}
```

#### `ttsService.ts`

```ts
export type TtsStreamId = 'tts' | 'tts-mon';
export interface TtsPlaybackSink {
  /** Idempotent, memoised per streamId+deviceId; re-opens when the device changed. */
  open(streamId: TtsStreamId, deviceId: string): Promise<void>;
  push(streamId: TtsStreamId, b64: string): void;
  close(streamId: TtsStreamId): void;
}
export interface TtsServiceDeps {
  fetch: FetchLike;
  apiKey: () => string | undefined;
  devices: () => { toMeet?: string; headset?: string };
  prefs: () => { voice: string; model: string; monitor: boolean };
  busy: () => boolean;                 // setup wizard/review owns the devices
  sink: TtsPlaybackSink;
  now: () => number;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
  logger?: Logger;
}
export interface TtsSpeakOptions { signal?: AbortSignal; onFirstAudio?: () => void }
export class TtsError extends Error { constructor(readonly code: AssistantErrorCode) { super(code); this.name = 'TtsError'; } }
export const IDLE_CLOSE_MS = 30000;
export class TtsService {
  constructor(deps: TtsServiceDeps);
  /** FIFO; resolves when the audio has been pushed and its playout time elapsed. */
  speak(text: string, lang: LanguageCode, opts?: TtsSpeakOptions): Promise<void>;
  /** Abort current fetch, reject queued items with AbortError, close both streams. */
  stopAll(): void;
}
```

Per item: checks in order `busy` → `tts-busy-setup`, key → `no-openai-key`, `toMeet` → `tts-no-device`, `text.length > MAX_TTS_INPUT_CHARS` → `tts-failed` (log `tts_input_too_long {chars}`); `sink.open('tts')` (+ `'tts-mon'` when monitor and headset); `fetch` per spec §6.5 (language name from `LANGUAGES`, no U4 import); 429 → `rate-limited`, other non-ok or null `body` → `tts-failed`; stream via the chunker; record `firstPushAt` on the first push and fire `onFirstAudio`; after flush wait until `firstPushAt + totalSamples / 24 + 300` ms (`max(0, … − now())`); then start/restart the idle-close timer. `stopAll` bumps a generation so late chunks of an aborted item are not pushed.

#### `speakController.ts`

```ts
export interface TranscriptSink {
  upsert(e: TranscriptEntry): void;
  patch(id: string, p: Partial<Omit<TranscriptEntry, 'id'>>): TranscriptEntry | undefined;
}
export interface SpeakControllerDeps {
  store: TranscriptSink;
  translate: (text: string, from: LanguageCode, to: LanguageCode, signal: AbortSignal) => Promise<string>;
  tts: { speak(text: string, lang: LanguageCode, o?: TtsSpeakOptions): Promise<void>; stopAll(): void };
  langs: () => { user: LanguageCode; them: LanguageCode };
  onError: (code: AssistantErrorCode) => void;
  now: () => number; newId: () => string; logger?: Logger;
}
export class SpeakController {
  constructor(deps: SpeakControllerDeps);
  speak(a: SpeakArgs): { entryId: string };
  stop(): void;
}
```

- Entry: `id: typed-${newId()}`, `direction 'A'`, `speaker 'me'`, `source 'typed'`, `final: true`, `speak: 'queued'`, `original: a.text.trim()`, `translated: a.translation ?? ''`, `originalLang: user`, `translatedLang: them` (languages captured at `speak()` time).
- `this.chain = this.chain.then(() => run(item))` — the whole translate → TTS step is chained, so order is strict. `run` never rejects (errors handled inside).
- `stop()`: bump a generation, abort the current item's `AbortController`, `tts.stopAll()`, and patch every not-yet-finished item (queued or running) to `cancelled`; items of an old generation return immediately when their turn comes.
- Errors: any `code` property in `ASSISTANT_ERROR_CODES` → that code, else `unknown`; `AbortError` after `stop()` → `cancelled`, not an error.

#### Tests

chunker (odd carry with value check, exact chunks, flush, `totalSamples`); ttsService (URL/body/instructions rule, check order incl. `busy` first, open → push → resolve at `firstPushAt + duration + 300` with a slow download, monitor on/off, FIFO, `stopAll` aborts/closes/rejects queue, 429/500/null body, input too long, idle close 30 s); speakController (statuses incl. `queued`; skip-translate paths; **two items whose translations resolve in reverse order are spoken in submission order**; translate error → `error` + `onError`; `stop()` → `cancelled` for running and queued; truncated translation error not spoken).

---

### U6: STT services (OpenAI only)

Scope cut: engines are `'off' | 'openai'`. `localWhisperStt.ts`, `LocalSttBridge`, `reloadLocalModel`, `onLocalStatus` and the `behind` logic are **deferred to M7**. Structure the code so M7 only adds a factory and a table entry.

#### `sttTypes.ts`

```ts
export interface SttTarget { streamId: string; direction: Direction; lang: LanguageCode }
export interface SttSegment { id: string; direction: Direction; text: string; final: boolean; mode: 'append' | 'replace' }
export interface SttEngineInstance { stop(): void; appendPcm?(b64: string): void }
export interface SttEngineFactory {
  create(t: SttTarget, onSegment: (s: SttSegment) => void, onError: (c: AssistantErrorCode) => void): SttEngineInstance;
}
export type ActiveSttEngine = Exclude<SttEngine, 'off'>;       // M6: 'openai'
export const TAP_MODE_FOR_ENGINE: Record<ActiveSttEngine, TapMode> = { openai: 'main24k' };
export interface SttTapController {
  setTap(streamId: string, mode: TapMode, opts?: TapOptions, onPcm?: (b64: string) => void): Promise<void>;
}
```

`mode: 'replace'` is kept in `SttSegment` (OpenAI `completed` events use it).

#### `openaiSttProtocol.ts` (pure)

```ts
export const OPENAI_STT_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
export function buildSttSessionUpdate(model: string, lang: LanguageCode, nearField: boolean): object;
export type SttEvent =
  | { kind: 'delta'; itemId: string; text: string }
  | { kind: 'completed'; itemId: string; text: string }
  | { kind: 'failed'; itemId: string }
  | { kind: 'error'; code: string; type: string; param?: string; fatal: boolean };
export function parseSttEvent(raw: string): SttEvent | undefined;
```

`fatal` when `type === 'invalid_request_error'` or `code === 'invalid_api_key'`.

#### `openaiRealtimeStt.ts`

```ts
export const COMMIT_IDLE_MS = 350;
export const MIN_COMMIT_MS = 200;
export const MAX_SEGMENT_MS = 15000;
export interface OpenAiRealtimeSttConfig {
  apiKey: string; model: string; target: SttTarget;
  wsFactory: WebSocketFactory;          // type from '../translate/openaiSession'
  onSegment: (s: SttSegment) => void; onError: (c: AssistantErrorCode) => void;
  backoff?: BackoffConfig;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout; logger?: Logger;
}
export class OpenAiRealtimeStt implements SttEngineInstance {
  constructor(cfg: OpenAiRealtimeSttConfig);
  start(): void; appendPcm(b64: string): void; stop(): void;
}
export function createOpenAiSttFactory(deps: {
  apiKey: () => string | undefined; model: () => string; wsFactory: WebSocketFactory;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout; logger?: Logger;
}): SttEngineFactory;
```

- `create()` with no key: call `onError('no-openai-key')` and return `{ stop() {} }` (no `appendPcm`); nothing connects.
- On open: **reset backoff and attempt counter** (mirroring `openaiSession.ts`, but unconditionally — STT has no "server error then close" loop because fatal errors stop reconnecting), log `stt_session_open {streamId, model}`, send `buildSttSessionUpdate(model, lang, direction === 'A')`, flush the pre-open queue (cap 100, drop oldest).
- `appendPcm`: send append (or queue before open); `uncommittedMs += (base64ByteLength / 2) / 24000 * 1000`; restart the `COMMIT_IDLE_MS` timer; commit immediately at `MAX_SEGMENT_MS`. Idle timer fire: commit only if `uncommittedMs ≥ MIN_COMMIT_MS`; reset after commit.
- Close: reconnect via `ExponentialBackoff` (1000/30000/5), dropping queued PCM; exhausted → `onError('stt-failed')`. A fatal error event → log `stt_session_rejected {code, param}`, close, no reconnect, `onError('stt-failed')`.
- Segment ids `${streamId}-${itemId}` (cap 80 chars). `failed` → `{text: '', final: true, mode: 'append'}` + log `stt_item_failed`.

#### `sttService.ts`

```ts
export interface SttServiceDeps {
  engines: Record<ActiveSttEngine, SttEngineFactory>;   // M6: { openai }
  tap: SttTapController;
  models: () => Record<ActiveSttEngine, string>;        // M6: { openai: sttOpenAiModel }
  onSegment: (s: SttSegment) => void;
  onStatus: (s: SttStatus) => void;
  now: () => number;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
  logger?: Logger;
}
export class SttService {
  constructor(deps: SttServiceDeps);
  sync(engine: SttEngine, targets: SttTarget[]): Promise<void>;
  retry(): Promise<void>;
  stopAll(): Promise<void>;
  status(): SttStatus;
}
```

- Key `${streamId}|${engine}|${model}|${lang}`. `engine === 'off'` → no wanted streams. Stop unwanted (`setTap(id,'off')` then `stop()`), start missing (`create`, then `setTap(id, TAP_MODE_FOR_ENGINE[engine], {model, lang}, instance.appendPcm?.bind(instance))`; on throw: `stop()`, log `stt_tap_failed {streamId}`, error `stt-failed`). Internal promise chain serializes `sync`/`retry`/`stopAll`. Remember the last `(engine, targets)`.
- `retry()`: clear the error, stop all instances, then `sync(last…)`. (M7 adds a local-model reload step here.)
- Status: `engine`, `streams` (directions of instances), `state` (`off` when none; `error` when an error code is set; otherwise `listening`), `errorCode`. Emit only on change (deep compare).
- `onError(code)` from an engine sets `errorCode` and `state: 'error'`; `no-openai-key` included.

#### `sttEntry.ts`

```ts
export function sttSegmentToEntry(prev: TranscriptEntry | undefined, s: SttSegment,
  langs: { user: LanguageCode; them: LanguageCode }, now: number): TranscriptEntry | undefined;
```

Id `stt-${s.id}`; `append` uses `joinDelta` from `@shared/assistant`; `replace` sets `original = s.text`; `final = prev?.final || s.final`; `translated = prev?.translated ?? ''`; A → `originalLang user`, B → `them`; returns `undefined` when `prev` is undefined and `s.text.trim()` is empty; `startedAt = prev?.startedAt ?? now`.

#### Tests

protocol (mini/live models, A/B noise reduction, every event kind, malformed → undefined); openaiRealtimeStt (`FakeWebSocket` copied from `openaiSession.test.ts`: URL/headers, update on open, appends, ms-based commit after 350 ms only when ≥ 200 ms, forced commit at 15 s, pre-open cap, reconnect, **backoff reset after a successful reopen — 7 consecutive open-then-close cycles never exhaust**, fatal no reconnect, segment mapping, failed item); factory with no key; sttService (start/stop order, `main24k` tap mode with the `appendPcm` callback, `'off'` stops everything, no-op unchanged, engine/model/lang change restarts, setTap failure cleanup, retry, no-key error status, status emitted only on change); sttEntry (append/replace, final latch, failed finalize, undefined for empty first segment).

---

### U7: Translate session input transcription option

**`OpenAISessionConfig`:** `inputTranscriptionModel?: string`. **`OpenAISessionEvents`:** `onInputTranscriptionRejected?: () => void`.

In `handleOpen`:

- Send the existing `session.update` **unchanged** (keep the comment at lines 156-159 as is, adding one line: "M6: input transcription is sent as a separate second update, see below").
- Then, if `cfg.inputTranscriptionModel && !this.inputTranscriptionRejected`, send `{type:'session.update', session:{audio:{output:{language, ...(voice)}, input:{transcription:{model}}}}}` and set `this.inputTranscriptionActive = true`.

In `handleMessage` for `error`: if `inputTranscriptionActive` and `(err.param ?? '') + ' ' + (err.message ?? '')` matches `/audio\.input|transcription/i`, then set `inputTranscriptionRejected = true` (latched for this object), `inputTranscriptionActive = false`, log `input_transcription_rejected {code, param}` (no message), call `onInputTranscriptionRejected?.()` once, and **return without touching `lastServerErrorMessage`**. Other errors behave as today.

**`SessionManagerConfig`:** `inputTranscriptionModel?: string` and `onInputTranscriptionRejected?: (direction: Direction) => void`, passed to each direction's session with conditional spreads.

**Tests:**

- `openaiSession.test.ts`: without the option, frames equal today's (deep equal, exactly one update); with it, the **first** frame deep-equals today's and the second has `audio.input.transcription.model === 'gpt-realtime-whisper'` and the same `audio.output`; an `error` with `param: 'session.audio.input.transcription'` calls the callback once, does not block the backoff reset on the next open, and after a reconnect only one update is sent; an unrelated error is handled as today.
- `sessionManager.test.ts`: the option and callback reach both sessions; the missing `onTranscript` assertion (input delta on A → `onTranscript({direction:'A', kind:'input', text})`).

---

### U8b: Offscreen PCM tap and playback options (tts streams)

Scope cut: only the `main24k` PCM tap, playback options and the `tts` / `tts-mon` playback streams. `whisper.worker.ts`, `whisperClient.ts`, `ortAssets.ts`, the `local16k` tap, segmenters, `bootId`/`seq`, STT result/status forwarding and `reloadWhisper` are **deferred to M7**.

#### `webAudioBridge.ts`

- `export interface PcmTap { rate: 24000; onFrame(f: Float32Array): void }` (M7 widens `rate` to `16000 | 24000`).
- `startPassthrough(…)` returns `PassthroughHandle extends CaptureHandle { setTap(t: PcmTap | null): void }`.
- `setTap` builds `Resampler(ctx.sampleRate, rate)`, `FrameBatcher` (check its real constructor in `src/shared/util/audioAnalysis.ts`) of `rate * 0.04` samples, `SilenceGate({sampleRate: rate, hangoverMs: 400, tailMs: 500})`; `null` clears it.
- In `port.onmessage`, after `meter.push(e.data)`, run the chain inside try/catch (a failing sink never breaks the meter/route; log once via `console.warn`).
- `startPlayback(outputDeviceId, hooks?, opts?: PlaybackOptions)`: backlog cap `opts?.maxBacklogS ?? MAX_PLAYBACK_BACKLOG_S`, catch-up rate `opts?.catchup === false ? 1 : CATCHUP_RATE`. Defaults unchanged.

#### `offscreen/index.ts`

- Replace the `declare global` `offscreenBridge` shape with `offscreenBridge?: OffscreenPreloadBridge` and `offscreen: OffscreenWindowApi & OffscreenAssistantApi`; type `api` the same; always call through `window.offscreenBridge?.`.
- State: `taps: Map<string, {mode: TapMode; opts: TapOptions}>`.
- `setPassthroughTap(streamId, mode, opts)`: store (delete on `off`), `applyTap(streamId)`, **return without awaiting anything slow**.
- `applyTap`: `main24k` → `setTap({rate: 24000, onFrame: f => bridge?.sendPcm(streamId, float32ToPcm16Base64(f))})`; `off` → `setTap(null)`. Write it as a `switch` on `TapMode` with an exhaustive `never` check, so M7's `local16k` is a compile-time-guided addition.
- `api.startPassthrough`: after `startInSlot` succeeds, `applyTap(streamId)`. `stopStream`/`stopAll` do not delete `taps`.
- `startPlaybackWithOptions(streamId, outDeviceId, opts)`: like `startPlayback`, passing `opts`. Check that the existing playback slot logic accepts the new stream ids `tts` and `tts-mon` (two concurrent playback streams besides the translate ones) and that `onPushPlayback` routes chunks to them by `streamId`; report if any id-based special case (e.g. a `pass-*` / translate-id switch) needs a change.

#### Verification

No unit tests (DOM); typecheck + lint. Run `npm run dev` and from the offscreen devtools console: `window.offscreen.setPassthroughTap('pass-B','main24k')` while passthrough runs → no console errors, meters and passthrough audio unaffected (main ignores the PCM until U11c registers a tap callback); `setPassthroughTap('pass-B','off')` clears it. Report the result.

---

### U9: Transcript window UI

Use `rt` from `src/renderer/ipc/client.ts`, `useT()`, tokens from `tokens.css`.

#### `transcript-main.tsx`

Like `setup-main.tsx`: resolve the locale, set `document.documentElement.lang = locale`, wrap in `I18nProvider`, render `<TranscriptWindow/>`, import `./styles/transcript.css`.

#### `state/transcriptState.ts` (pure)

```ts
export interface TranscriptViewState {
  entries: TranscriptEntry[];
  suggestions: SuggestionsState;
  stt: SttStatus;
  prefs: AssistantPrefs;
  context: AssistantContext;
  lastError?: { scope: AssistantErrorScope; code: AssistantErrorCode; at: number };
}
export type TranscriptAction =
  | { type: 'snapshot'; entries: TranscriptEntry[] }
  | { type: 'upsert'; entry: TranscriptEntry }
  | { type: 'cleared' }
  | { type: 'suggestions'; s: SuggestionsState }
  | { type: 'stt'; s: SttStatus }
  | { type: 'prefs'; p: AssistantPrefs }
  | { type: 'context'; c: AssistantContext }
  | { type: 'error'; scope: AssistantErrorScope; code: AssistantErrorCode; at: number };
export function initialTranscriptState(prefs: AssistantPrefs): TranscriptViewState;
export function transcriptReducer(s: TranscriptViewState, a: TranscriptAction): TranscriptViewState;
export function displayLines(e: TranscriptEntry): { primary: string; secondary: string };
export type HeaderStatus = 'translating' | 'sttOpenai' | 'off' | 'error'; // M7 adds 'sttLocal' | 'loadingModel' | 'behind'
export function headerStatus(s: TranscriptViewState): HeaderStatus;
export function showSttCta(s: TranscriptViewState): boolean; // !context.translating && prefs.sttEngine === 'off'
```

Reducer: upsert replaces when incoming `updatedAt ≥` current, else appends; sorted by `startedAt`; cap 500; snapshot merges keeping the newer `updatedAt`; `cleared` empties entries. `displayLines`: `them` → primary `translated || original`, secondary `translated ? original : ''`; `me` → primary `original || translated`, secondary `original ? translated : ''`. `headerStatus` precedence: translating → error → sttOpenai (engine `openai`) → off.

#### `useTranscriptSubscription.ts`

`useReducer`; subscribe to `onTranscriptEntry`, `onTranscriptCleared`, `onSuggestions`, `onSttStatus`, `onAssistantError`, `onAssistantPrefs`, `onAssistantContext`; then fetch `getTranscript`, `getSuggestions`, `getSttStatus`, `getAssistantContext`, `loadPrefs` (→ `resolveAssistantPrefs(prefs.assistant)`); pushes that arrived during the fetch win (the `useHealthSubscription` pattern). Returns `state`.

#### Components (`src/renderer/views/transcript/`)

- `TranscriptWindow.tsx`: flex column: header, CTA (when `showSttCta`), list, suggestions, composer.
- `TranscriptHeader.tsx`: status text from `headerStatus` (`transcript.status.*`); Retry button on `error` → `rt.retryStt()`; pin button → `rt.setTranscriptAlwaysOnTop(!pinned)` (initial from `loadPrefs().transcriptWindow?.alwaysOnTop`); "More" popover: Clear (local confirm modal using `transcript.confirmClear`, `common.cancel`, `transcript.menu.clearConfirm`), Export txt/md (`rt.exportTranscript`), Assistant settings → `rt.openAssistantSettings()`.
- `SttCta.tsx`: title, one button `transcript.cta.openai` → `rt.setAssistantPrefs({sttEngine: 'openai'})` (disabled with the `transcript.composer.noKey` hint when `!context.hasOpenAiKey`), hint. (M7 adds the local button.)
- `TranscriptList.tsx`: sticky-bottom within 40 px, "Jump to latest" chip, empty state.
- `EntryBubble.tsx`: `tr-entry tr-entry--me|--them`, `tr-entry--live` when not final; lines; typed badge; speak status `transcript.speak.*`; Retry on `error` only → `rt.speakText(translated ? {text: original, translate: false, translation: translated} : {text: original, translate: true})`; `title` = local time.
- `SuggestionsPanel.tsx`: only when `prefs.suggestionsEnabled`; collapsible (state in `localStorage`, try/catch); Suggest → `rt.suggestNow()`; cards (body click → `onEdit(text)`, Speak as spec §11.1); `needsStt` hint when `showSttCta`; error line `t(\`assistant.errors.${code}\`)`.
- `Composer.tsx`: textarea, Enter sends unless `e.shiftKey || e.nativeEvent.isComposing`; `maxLength = MAX_SPEAK_CHARS` + counter; translate toggle (hidden when `context.langs.user === context.langs.them`, label with the language name); Send → `rt.speakText({text, translate})`, clears on success; Stop → `rt.stopSpeaking()`; hints from `context`: `!hasOpenAiKey` → `noKey`, `!hasToMeetDevice` → `noDevice`, `setupBusy` → `setupBusy` (Send disabled in all three).

#### `styles/transcript.css`

Imports `./tokens.css`; `.tr-*` prefix; dark only; `me` right (`--accent-muted` / `--accent-border`), `them` left (`--surface-elevated`); secondary `--text-tertiary` 12 px; composer pinned (flex column, list `flex:1; overflow:auto`); copy the minimal `.btn` rules **and the `.confirm-modal*` rules** from `setup.css` (do not import `setup.css`).

#### Tests: `transcriptState.test.ts`

Upsert ordering and newer-wins; snapshot merge; cap 500; `cleared`; `context` action; `displayLines` per combination; `headerStatus` precedence; `showSttCta`.

---

### U10: Assistant settings UI

- `useHashRoute.ts`: `{ kind: 'assistant' }`, regex alternation, `parseHashRoute`, `navigate` → `'#/assistant'`.
- `SetupRoot.tsx`: `assistant` → `<AssistantScreen/>`.
- `ReviewScreen.tsx`: 7th `ReviewSection` after Troubleshoot (`status: 'info'`, title `review.section.assistant`, value `t('review.section.assistantValue', assistantSummary(prefs, t))`, action `review.section.open` → `navigate({kind:'assistant'})`); prefs via `rt.loadPrefs()` in a `useEffect`.
- `assistantSummary.ts` (pure): `assistantSummary(p: AssistantPrefs, t: T): { stt: string; llm: string }` — `stt` from `assistant.stt.off|openai`; `llm` = `${t('assistant.llm.<preset>')} · ${model || '—'}`.
- `AssistantScreen.tsx` (layout like `TroubleshootScreen`, back → `navigate({kind:'review'})`):
  - Load `resolveAssistantPrefs((await rt.loadPrefs()).assistant)`, `rt.getLlmKeyHint()`, `rt.getSttStatus()`, subscribe `rt.onSttStatus` and `rt.onAssistantPrefs`.
  - `save(patch)` → `setPrefs(await rt.setAssistantPrefs(patch))`. Text inputs save on blur, base URL only if `isValidBaseUrl`.
  - **Live transcript:** engine radio with exactly the choices of `STT_ENGINES` (Off / OpenAI; render the radio from that list so M7's `local` appears by adding a label); OpenAI model select (`STT_OPENAI_MODELS`, shown when the engine is `openai`); state line (`assistant.stt.state.*`); Retry → `rt.retryStt()` on error; `costOpenai` hint; checkboxes `translateInputTranscript` (hint incl. "applies from the next Start"), `translateTheirSpeech`, `transcriptOpenOnLaunch`; "Open transcript" → `rt.openTranscriptView()`.
  - **AI model:** preset segmented buttons (preset → `{llm: {preset, ...LLM_PRESETS[preset]}}`; `custom` saves only `preset`); base URL; model + "Load models" (`rt.listLlmModels()` → `<datalist>`, `modelsEmpty`/`modelsFailed`); reasoning `<select>` from `REASONING_EFFORTS` (`''` labelled `reasoningDefault`); key field only when `!isOpenAiHost(baseUrl)` (save → `rt.setLlmKey`, clear → `rt.clearLlmKey`, `apiKeySaved` hint), else `openaiKeyUsed`; `insecureWarn` for `http:` non-loopback; Test → `rt.testLlm()` → `testOk` or the error text, plus `hintOllama` (with the model) when the preset is `ollama` and the code is `llm-unreachable` or `llm-model-missing`; `cost` note.
  - **Voice:** select from `TTS_VOICES`, monitor checkbox + `monitorWarn`, `cost` note.
  - **Suggestions:** enabled, auto, hint.
- `setup.css`: `.assist-*` classes (segmented control, radio rows, inline status); reuse `.setup-input`, `.setup-field-label`, `.setup-field-hint`, `.btn*`.

Tests: `useHashRoute.test.ts` (`#/assistant` parse + navigate), `assistantSummary.test.ts` (en-US `t`).

---

### U11b: Transcript window module (main, Electron allowed)

#### `windowBounds.ts` (pure)

```ts
export interface Rect { x: number; y: number; width: number; height: number }
/** Returns bounds fully reachable: keeps size (clamped to the work area), moves the window onto the display it overlaps most, or centers it on the primary work area when it overlaps none. */
export function clampBoundsToDisplays(b: { x?: number; y?: number; width: number; height: number }, workAreas: Rect[], primary: Rect): Rect;
```

#### `transcriptWindow.ts`

```ts
import { BrowserWindow, screen } from 'electron';
export interface TranscriptWindowDeps {
  url: string; preloadPath: string;
  loadPrefs: () => TranscriptWindowPrefs;               // stored ?? DEFAULT_TRANSCRIPT_WINDOW
  savePrefs: (p: Partial<TranscriptWindowPrefs>) => void;
  attachGuards: (w: BrowserWindow) => void;            // navigation guard + external-link handler
}
export interface TranscriptWindowController {
  open(): Promise<void>;                 // singleton: focus/restore if open
  get(): BrowserWindow | undefined;
  setAlwaysOnTop(value: boolean): void;  // persists + applies at level 'floating'
  close(): void;
}
export function createTranscriptWindowController(deps: TranscriptWindowDeps): TranscriptWindowController;
```

420×640 default, min 320×360, `backgroundColor '#08090a'`, `show: false` then show on `ready-to-show`, `contextIsolation: true`, `nodeIntegration: false`, `sandbox` as the setup window uses, bounds through `clampBoundsToDisplays(stored, screen.getAllDisplays().map(d => d.workArea), screen.getPrimaryDisplay().workArea)`, `alwaysOnTop` applied with `'floating'`, bounds saved on `moved`/`resized` with a 300 ms debounce, reference assigned before `loadURL` and cleared on `closed`. No quit logic.

Test: `windowBounds.test.ts` (inside, partly off-screen, fully off-screen → centered on primary, larger than work area → shrunk, multi-display).

---

## WAVE 3

### U11a: `AssistantRuntime` (`src/main/assistant/assistantRuntime.ts`, no Electron)

Scope cut: no local STT factory, no `LocalSttBridge`, no `onLocalSttStatus` (M7).

```ts
export interface AssistantAudioState {
  translating: boolean;
  langs: { user: LanguageCode; them: LanguageCode };
  ttsDevices: { toMeet?: string; headset?: string };
  /** Passthrough streams running now that may be transcribed. */
  sttStreams: { direction: Direction; streamId: string }[];
  setupBusy: boolean;
}
export interface AssistantOffscreenPort extends SttTapController {   // M7 adds LocalSttBridge + reloadLocalModel
  startPlaybackWithOptions(streamId: string, deviceId: string, opts: PlaybackOptions): Promise<void>;
  pushPlayback(streamId: string, b64: string): void;
  stopStream(streamId: string): void;
}
export interface SecretStore { getApiKey(): string | undefined; setApiKey(v: string): void; clearApiKey(): void }
export type AssistantBroadcast = <K extends keyof IpcSendMap>(channel: K, payload: IpcSendMap[K]) => void; // type-only import of channels.ts
export interface AssistantRuntimeDeps {
  fetch: FetchLike;
  wsFactory: WebSocketFactory;
  offscreen: AssistantOffscreenPort;
  loadStoredPrefs: () => StoredAssistantPrefs | undefined;
  saveAssistantPrefs: (patch: AssistantPrefsPatch) => AssistantPrefs;
  openAiKey: () => string | undefined;
  llmKeyStore: SecretStore;
  audioState: () => AssistantAudioState;
  serialized: <T>(fn: () => Promise<T>) => Promise<T>;
  broadcast: AssistantBroadcast;
  t: T;
  logger: Logger;
  now?: () => number; newId?: () => string;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval; clearIntervalFn?: typeof clearInterval;
}
export interface AssistantWindowOps {
  openTranscriptView(): Promise<void>;
  openAssistantSettings(): Promise<void>;
  setTranscriptAlwaysOnTop(value: boolean): void;
  saveExport(format: 'txt' | 'md', text: string, sender: unknown): Promise<{ saved: boolean }>;
}
export class AssistantRuntime {
  constructor(deps: AssistantRuntimeDeps);
  prefs(): AssistantPrefs;                      // cached; invalidated on save and onPrefsChanged
  context(): AssistantContext;
  inputTranscriptionModel(): string | undefined; // 'gpt-realtime-whisper' when the pref is on
  onTranslateStart(): void;                      // starts the 500 ms tick; pushes context
  onTranslateStop(): void;                       // finalizeAll → upsert; stops the tick; pushes context
  onTranslateDelta(d: { direction: Direction; kind: 'input' | 'output'; text: string }): void;
  onInputTranscriptionRejected(direction: Direction): void; // broadcast AssistantError {scope:'stt', code:'input-transcript-unsupported'} once per Start
  /** Converges STT to audioState(). Caller MUST run it inside serialized(); never calls serialized itself. */
  syncAudio(): Promise<void>;
  /** From handlers.ts hook. Invalidates caches; 'devices' → tts.stopAll(); pushes context; then deps.serialized(() => this.syncAudio()). */
  onPrefsChanged(what: 'languages' | 'devices' | 'apiKey'): Promise<void>;
  onDeviceChange(): void;                        // tts.stopAll() (drops memoised TTS streams)
  onTtsStreamEvent(): void;                      // tts.stopAll()
  onSetupViewChanged(): void;                    // pushes context (setupBusy)
  stopForDiagnostics(): Promise<void>;           // stt.stopAll(); tts.stopAll()
  handlerDeps(win: AssistantWindowOps): Omit<AssistantHandlerDeps, 'isTrustedSender'>;
  dispose(): Promise<void>;                      // speak.stop(); suggestions.cancel(); stt.stopAll(); tick cleared
}
```

Composition (all inside the constructor):

- **Prefs cache:** `prefs()` = cached `resolveAssistantPrefs(loadStoredPrefs())`.
- **Store/assembler:** `TranscriptStore({onUpsert → broadcast(TranscriptEntry), onCleared → broadcast(TranscriptCleared, undefined), onFinal → this.handleFinal})`; `TranscriptAssembler({langs: () => audioState().langs})`.
- **handleFinal(e):** if `e.speaker === 'them' && e.source === 'stt' && !e.translated && prefs().translateTheirSpeech && langs differ`, enqueue on a their-speech queue (serial chain, at most 3 pending, oldest dropped): `translateWith(llm, original, them, user)` → `store.patch(e.id, {translated, translatedLang: user})`; then (success or failure) `suggestions.onFinalEntry(store.get(e.id) ?? e)`. Otherwise `suggestions.onFinalEntry(e)` directly. Failures log `their_speech_translate_failed {code}` only.
- **LLM:** `LlmClient({fetch, logger, config: () => { const l = prefs().llm; const k = selectLlmKey(l.baseUrl, openAiKey(), llmKeyStore.getApiKey()); return {baseUrl: l.baseUrl, model: l.model, reasoningEffort: l.reasoningEffort, ...(k ? {apiKey: k} : {})}; }})`.
- **Suggestions:** `recent: () => store.recent({maxEntries: 30, maxChars: 6000, finalOnly: true})`, `enabled` from prefs, `onState → broadcast(SuggestionsChanged)`.
- **TTS sink** over `offscreen`: `open` memoised in `Map<TtsStreamId, {deviceId, p: Promise<void>}>` (a different device → `stopStream` then re-open with `startPlaybackWithOptions(id, deviceId, {maxBacklogS: 120, catchup: false})`; a rejection deletes the memo and rethrows); `push → pushPlayback`; `close → stopStream` + delete memo.
- **TTS:** `apiKey: openAiKey`, `devices: () => audioState().ttsDevices`, `busy: () => audioState().setupBusy`, prefs from `prefs()`.
- **Speak:** `SpeakController({translate: (t, f, to, s) => translateWith(llm, t, f, to, s), langs: () => audioState().langs, onError → broadcast(AssistantError, {scope:'speak', code}), newId})`.
- **STT:** `SttService({engines: {openai: createOpenAiSttFactory({apiKey: openAiKey, model: () => prefs().sttOpenAiModel, wsFactory, logger})}, tap: offscreen, models: () => ({openai: prefs().sttOpenAiModel}), onSegment: s => { const e = sttSegmentToEntry(store.get(\`stt-${s.id}\`), s, audioState().langs, now()); if (e) store.upsert(e); }, onStatus → broadcast(SttStatusChanged)})`.
- **syncAudio:** `const st = audioState(); const engine = prefs().sttEngine; const targets = st.setupBusy ? [] : st.sttStreams.map(({direction, streamId}) => ({streamId, direction, lang: direction === 'A' ? st.langs.user : st.langs.them})); await stt.sync(engine, targets);` (no key handling here: the OpenAI factory reports `no-openai-key`). Then push context if it changed.
- **Context:** `{langs, translating, hasOpenAiKey: !!openAiKey(), hasToMeetDevice: !!ttsDevices.toMeet, setupBusy}`; `broadcast(AssistantContextChanged)` only when it changed (deep compare).
- **handlerDeps(win):** `getTranscript → store.snapshot()`; `clearTranscript → store.clear()`; `exportTranscript(format, sender) → win.saveExport(format, formatTranscript(store.snapshot(), {format, t, date: new Date(now())}), sender)`; `setAssistantPrefs(patch) → { const p = saveAssistantPrefs(patch); invalidate; broadcast(AssistantPrefsChanged, p); if (!p.suggestionsEnabled) suggestions.cancel(); await serialized(() => this.syncAudio()); return p; }`; `getLlmKeyHint` → last 4 when length > 4; `setLlmKey`/`clearLlmKey` → `llmKeyStore`; `testLlm` → time `llm.complete({messages: [{role: 'user', content: 'Reply with OK.'}], maxTokens: TEST_MAX_TOKENS, timeoutMs: isOpenAiHost ? 20000 : 120000})`, non-empty required, `LlmError` → `{ok:false, code}`, other → `unknown`; `listLlmModels` likewise; `speakText → speak.speak`; `stopSpeaking → speak.stop()`; `suggestNow → suggestions.requestNow()`; `getSuggestions`, `getSttStatus → stt.status()`; `retryStt → serialized(() => stt.retry())`; `getAssistantContext → context()`; window ops pass through.

Tests (`assistantRuntime.test.ts`, fakes for fetch, ws, offscreen port, stores, `serialized = fn => fn()`, fake timers):

- `syncAudio` targets: passthrough both; translating with no failed directions → none; parked A → only B; `setupBusy` → none; lang/model change restarts (via fake port `setTap` calls).
- `onPrefsChanged('apiKey')` re-syncs and pushes context; `'devices'` stops TTS (`stopStream('tts')` after a speak opened it).
- `onDeviceChange` closes the memoised TTS stream so the next speak re-opens.
- translate deltas → `TranscriptEntry` broadcasts; `onTranslateStop` finalizes.
- `translateTheirSpeech`: a final `them` STT entry is patched with the translation **before** suggestions run (fake LLM records call order); off → suggestions run directly; translation failure still triggers suggestions.
- OpenAI key never in the Authorization header for an `http://127.0.0.1` base URL.
- `setAssistantPrefs` invalidates the cache (second `prefs()` reflects the patch) and broadcasts.
- `testLlm` empty content → `{ok:false, code:'llm-bad-response'}`.

---

## WAVE 4

### U11c: `app.ts` wiring

Read spec §9. Scope cut: **no protocol code** (U1b is deferred; pages stay on `file://`), no CDN block, no local-STT plumbing (`reloadLocalModel`, `LocalSttBridge`, `SttResult`/`SttStatus` listeners, `onSttStatus` signal) — all M7.

1. **Imports:** `AssistantRuntime`, `createTranscriptWindowController`, `registerAssistantIpcHandlers`, `nodeFetch`, shared assistant types.
2. **URLs:** `TRANSCRIPT_URL` following the existing pattern of `SETUP_VIEW_URL` (dev server URL, else `file://${resolve(__dirname, '../renderer/transcript.html')}`). Confirm the existing `isAppUrl` (`file:` under `RENDERER_DIR`) accepts it unchanged.
3. **CDN block:** none in M6 (it only guarded the onnxruntime WASM loader; M7).
4. **LLM key store:** `new ConfigStore({ safeStorage: <same adapter>, fs: <same>, configPath: join(userData, 'llmkey.bin'), envApiKey: undefined })`.
5. **OffscreenBridge additions:**
   - `tapCallbacks: Map<string, (b64: string) => void>`; the Pcm listener dispatches `(this.pcmCallbacks.get(id) ?? this.tapCallbacks.get(id))?.(b64)`.
   - `setTap(streamId, mode, opts?, onPcm?)`: set `tapCallbacks` when `mode === 'main24k' && onPcm`, else delete; `if (!this.isAlive()) return;` then `exec(\`window.offscreen.setPassthroughTap(${J(streamId)}, ${J(mode)}, ${J(opts ?? {})})\`, OPEN_TIMEOUT_MS, 'setPassthroughTap')`.
   - `startPlaybackWithOptions(streamId, deviceId, opts)`: `exec(…, OPEN_TIMEOUT_MS, 'startPlaybackWithOptions')`.
   - `stopAll`/`dispose` clear `tapCallbacks`; `stopStream` does not clear `tapCallbacks`.
6. **Runtime:** construct after `prefsStore`, `configStore`, `logger`, `offscreenBridge`, `passthrough`, `serialized` exist:
   - `audioState()`: `translating = !!manager`; `langs` from `activeArgs` while translating, else `prefs.languages` (defaults `'pt'`/`'en'` as today); `ttsDevices` from `activeArgs` while translating, else `prefs.devices` (conditional spreads); `sttStreams` = translating ? `[...failedDirections].map(d => ({direction: d, streamId: <passthrough stream id for d>}))` : running `passthrough.streams` mapped back to directions, minus `A` when `passthrough.isMicParked`; `setupBusy = setupNeedsDevices()`. Use the existing direction ↔ stream-id mapping from `passthrough.ts`.
   - `broadcast` = the existing `broadcast`; `t` = main's translator; `serialized` = the existing helper.
7. **Hooks:**
   - end of `syncPassthrough()` (inside the serialized callback): `await assistant.syncAudio()`.
   - park/wake in `runPassthroughAction` (same serialized callback): `await assistant.syncAudio()`.
   - `onSetupViewChanged`: also `assistant.onSetupViewChanged()`.
   - `onStreamEvent`: `if (e.streamId.startsWith('tts')) { log as today; assistant.onTtsStreamEvent(); return; }` before health/recovery.
   - `onDeviceChange`: also `assistant.onDeviceChange()`.
   - `registerIpcHandlers({... , onPrefsChanged: (w) => { void assistant.onPrefsChanged(w).catch(logErr) }})`.
   - `emitTranscript`: keep the legacy broadcast, then `assistant.onTranslateDelta(t)`.
   - `onStart`: add a local `let starting = false`; `audioState().translating` is `!!manager || starting`. Inside the serialized `onStart`, set `starting = true` (in `try/finally`, reset after the manager is assigned or on failure), then `await assistant.syncAudio()` **before** the manager starts, so STT on `pass-*` stops before translation opens the devices. Pass `...(model ? { inputTranscriptionModel: model } : {})` from `assistant.inputTranscriptionModel()` and `onInputTranscriptionRejected: (d) => assistant.onInputTranscriptionRejected(d)` into the `SessionManager` config. After success, `assistant.onTranslateStart()`.
   - `onStop` and the `onStart` failure path: `assistant.onTranslateStop()` before `syncPassthrough()`.
   - `runDiagnostics`: `await assistant.stopForDiagnostics()` first.
   - `before-quit`: `void assistant.dispose()`.
8. **Transcript window:** `const transcriptWin = createTranscriptWindowController({url: TRANSCRIPT_URL, preloadPath: <same preload as setup>, loadPrefs: () => prefsStore.load().transcriptWindow ?? DEFAULT_TRANSCRIPT_WINDOW, savePrefs: (p) => prefsStore.setTranscriptWindow(p), attachGuards: (w) => { attachNavigationGuard(w); attachExternalLinkHandler(w); }})`.
   - Add `transcriptWin.get()` to `broadcast` and to `isTrustedSender`'s window list (frame URL check unchanged).
   - Bar menu first item `{ label: t('menu.transcript'), click: () => void transcriptWin.open() }`, then a separator.
   - Startup: after `createWindows`, `if (assistant.prefs().transcriptOpenOnLaunch && isSetupComplete(configStore, prefsStore)) void transcriptWin.open();`.
   - `quitIfNoVisibleWindow` unchanged (the transcript window does not keep the app alive); on quit, the controller's window closes with the app.
9. **Settings routing:** `setupNeedsDevices()` → `!(setupHash.startsWith('#/troubleshoot') || setupHash.startsWith('#/assistant'))`. Generalize `openTroubleshooting` into `openSetupAt(hash)`; `openTroubleshooting = () => openSetupAt('#/troubleshoot')`; `openAssistantSettings = () => openSetupAt('#/assistant')`.
10. **IPC:** `registerAssistantIpcHandlers(ipcMain, { isTrustedSender, ...assistant.handlerDeps({ openTranscriptView: () => transcriptWin.open(), openAssistantSettings, setTranscriptAlwaysOnTop: (v) => transcriptWin.setAlwaysOnTop(v), saveExport }) })` with

```ts
const saveExport = async (format: 'txt' | 'md', text: string, sender: unknown) => {
  const opts = { defaultPath: `transcript-${stamp()}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] };
  const w = BrowserWindow.fromWebContents(sender as WebContents);
  const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return { saved: false };
  writeFileSync(r.filePath, text, 'utf8');
  return { saved: true };
};
```

11. **Verify:** typecheck, lint, tests, `npm run build`, `npm run dev` smoke (bar, passthrough, transcript window opens, Settings from the transcript window keeps call audio).

---

## WAVE 5

### U12: Verification and docs

1. `npm run typecheck`, `npx eslint . --ext .ts,.tsx`, `npx vitest run`, `npm run build`; fix failures (any file).
2. **Privacy:** `grep -rnE "logger\.(info|warn|error|debug)\([^)]*(text|original|translated|content|prompt|suggest)" src/main`, inspect each hit. Run the app, use transcript, typed speech, suggestions, their-speech translation; grep `userData/logs/*.jsonl` for a spoken and a typed sentence: not found.
3. **Build (mandatory) + packaged smoke (optional):** `npm run build` must pass. Optionally `npm run dist` and run `release/win-unpacked`: bar/setup/passthrough work, the transcript window opens from the bar menu (it loads from `file://` like the other pages), OpenAI STT produces entries, typed speech is audible in the call. No COOP/COEP, `crossOriginIsolated` or model-cache checks in M6 (M7).
4. **Live checks of UNVERIFIED items**, recorded under "M6 verification notes" in `docs/QA-CHECKLIST.md`: GA STT session shape (`language` vs `languages`, `turn_detection: null`); input transcription accepted or rejected on the translate endpoint (and translation language still correct in both cases); output transcript presence; `reasoning_effort: 'minimal'` on `gpt-5-mini`; Ollama `reasoning_effort: 'none'`. (WebGPU in the hidden window, ort file names and dtype keys move to M7.)
5. **QA checklist "M6 Assistant":** spec §16 items plus: STT CTA one-click (OpenAI); `pass-A` park stops STT for A, wake resumes; TTS stream event does not restart call audio; CABLE-A unplug/replug then speak works; Settings opened from the transcript window keeps call audio; typed speech refused with `tts-busy-setup` during the wizard; two quick messages in order; Ollama stopped → `llm-unreachable` with the Ollama hint; `http://192.168.x.x` warning; window pinned and bounds persist, off-screen bounds recovered; all strings in it-IT and pt-BR.
6. **README:** "Assistant (transcript, typed speech, suggestions)" with the settings path, cost notes (spec §10.2), Ollama quick start (`ollama pull qwen3:8b`, base URL `http://127.0.0.1:11434/v1`).

---

## Expected test count

Baseline 243. After the scope cut M6 adds about 22 new test files and extends 5, roughly 170 new tests. Target ≥ 400 passing. (Not created in M6: `appProtocol`, `offscreenContract`, `utteranceSegmenter`, `whisperFilter`, `localWhisperStt` tests.)

---

## Review notes (revision 2)

*Note after the scope cut:* items about B1 / `app://`, COOP/COEP, the Whisper worker, ISO codes for Whisper and a `'local'` default now apply to M7; the decisions are kept as recorded. The `hangoverMs: 400` gate decision still applies to the M6 `main24k` tap.

All points of both reviews were checked against the source on `main-lore`. Accepted points are folded into the spec and the units above (key locations: B1 → U1b/§7.5; B2 → U7/§10.1; typed-speech ordering → U5; reasoning budgets → U4/§6.3; assembler lag → U3/§6.1; state in the window → `AssistantContext`; re-sync hooks → U1.6 + U11a; TTS recovery → U11a/U11c; https-only key → U1.1; Settings without killing audio → `OpenAssistantSettings`; signatures → authority rule + this plan; id reuse → §5.2/U8b; STT retry → U6/U11a; U11 and U8 split → U11a/b/c, U8a/b; typing fixes → U8b/U11c; i18n gaps → U2; passthrough coverage → CTA + `translateTheirSpeech`).

Rejected or replaced, with reasons:

- **New `SessionStateGet` invoke (review 1, M2):** replaced by `AssistantContext.translating` (fetched + pushed). The window needs more context than session state anyway, so one channel serves both.
- **Using `rt.getHealth()` for the translating flag (review 2, M1):** not used. `HealthReport.mode` would work today but couples the transcript UI to the health model; `AssistantContext` already carries the flag.
- **Keep `file://` with an IPC-backed `customCache` + IPC `wasmBinary` (review 1, B1 alternative):** rejected. More code and still no cross-origin isolation; the `app://` scheme fixes fetch, cache and threads together.
- **`app.commandLine.appendSwitch('enable-features','SharedArrayBuffer')` (review 2, B1):** rejected. It enables SAB without isolation, weakening Spectre protections; COOP/COEP on our own scheme is the supported way.
- **Re-send the whole `session.update` without the field after a rejection (review 2, B2):** replaced. The first update is never changed, so there is nothing to re-send; the rejection is only latched and reported.
- **Default `sttEngine` to `'local'` (review 2, coverage):** rejected. It would download ~80 MB and transcribe the mic without consent. The one-click CTA in the transcript window covers the gap.
- **Reserve the TTS queue slot synchronously (review 1, B3 alternative):** not chosen. Chaining the whole translate → TTS step in `SpeakController` is simpler and testable.
- **Never auto-clear suggestions / mark them stale (review 1, M11 alternative):** not chosen. Clearing only on spoken (`source !== 'typed'`) `me` entries with ≥ 2 words fixes both the spoken-suggestion and the keyboard-noise cases.
- **"Burmese is `myanmar` in Whisper" (review 1, minor 4):** the example is inaccurate (Whisper maps `my` to "burmese"), but the fix (pass ISO codes) is right and is applied.
- **`hangoverMs: 300` (review 2, minor 10):** 400 ms chosen instead, to avoid clipping word endings on the server side; latency is documented (≈ 1.25 s to commit) and criterion §16.1 relaxed to ~3 s.
- **Cap typed input at 4096 (review 1, minor 8):** typed input stays at 2000 chars; the 4096 cap applies to the TTS input (the translation), checked before the request.
- **`transcriptStore.get?.()` side map (plan v1):** dropped in favour of `TranscriptStore.get(id)` (review 2, M13).
