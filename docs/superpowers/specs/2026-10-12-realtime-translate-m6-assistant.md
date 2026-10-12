# M6 Spec: Call Assistant (live transcript, typed speech, reply suggestions)

**Status:** draft for implementation (revision 2, after the correctness and completeness reviews; scope cut 2026-10-12: local Whisper + `app://` deferred to M7)
**Date:** 2026-10-12
**Predecessor:** M5 (distribution) + the post-M5 passthrough/health work on `main-lore`
**Plan:** [`../plans/2026-10-12-realtime-translate-m6.md`](../plans/2026-10-12-realtime-translate-m6.md)

Facts about external APIs come from the OpenAI, Ollama, LM Studio, onnxruntime-web and transformers.js docs as read on 2026-10-12. Anything that could not be confirmed is marked **UNVERIFIED**. Each one sits behind a small adapter (one file, one pure parser) so it can be fixed in one place, and each has a live check in plan unit U12.

**Scope cut (2026-10-12).** By user decision, M6 ships OpenAI STT and every other feature; **local Whisper STT, the `app://renderer` production protocol and cross-origin isolation (COOP/COEP) are deferred to M7.** In M6 `SttEngine` is `'off' | 'openai'` and pages keep loading from `file://`. Parts below that belong to M7 are marked **Deferred to M7** and kept as the M7 reference design; M6 units must not implement them. See the plan's "Scope cut" section for the exact list.

**Authority rule.** This spec defines *behaviour*. The plan defines *exact signatures, file names and ownership*. Where the two disagree, **the plan wins**, and the unit agent reports the mismatch in its summary. To keep that rare, this spec only shows the shared data model (§5) and describes services by behaviour; it does not repeat service signatures.

---

## §1 Goal

Add three features on top of the existing two-direction translator:

1. **Live transcript window.** A separate window that can stay open and shows what both sides of the call say, while translating and while not translating (passthrough).
2. **Typed speech.** The user types a sentence in their own language. The app translates it into the other person's language and speaks it into the call on CABLE-A (the `toMeet` device), in both modes.
3. **Reply suggestions.** An LLM reads the recent conversation and suggests replies, for example when the other person asks a question. One click speaks a suggestion through feature 2.

The LLM for features 2 and 3 can be OpenAI (the user's existing key) or a local model behind an OpenAI-compatible API (Ollama, LM Studio). Speech-to-text in passthrough uses OpenAI realtime transcription (a local Whisper model running on the user's PC is **deferred to M7**).

Terminology:

- **User language** = `prefs.languages.source`. **Their language** = `prefs.languages.target`. While translating, the languages of the running session (`activeArgs`) are used instead.
- **Direction A**: user mic → translation → CABLE-A → call. Speaker `me`.
- **Direction B**: call → CABLE-B → translation → headset. Speaker `them`.

## §2 Non-goals

- No speaker diarization inside one direction. Several remote participants all count as `them`.
- No transcript persistence by default. Transcripts live in memory and reach disk only on an explicit Export.
- No summaries, minutes or action items (possible later on the same `LlmClient`).
- No local STT in M6 (**deferred to M7**: transformers.js Whisper, §7.3, plus the `app://` origin, §7.5). No native whisper.cpp sidecar in either milestone.
- No local TTS. Speech output uses OpenAI `/v1/audio/speech` only, so typed speech needs an OpenAI key even when the LLM is local.
- No voice cloning, no matching of the translate voice.
- No macOS or Linux work.
- The 560×40 floating bar does not grow. New UI lives in the transcript window and the setup window.
- `sttEngine` stays **off by default** (cost and mic transcription are opt-in; in M7 also a large model download). The transcript window instead shows a one-click call to action (§11.1).

## §3 Decisions summary

| Topic | Decision |
|---|---|
| Transcript while translating | Reuse the `session.input_transcript.delta` / `session.output_transcript.delta` events the translate sessions already emit. |
| Source-language transcript while translating | Opt-in pref `translateInputTranscript` (default **off**). Sent as a **separate, second** `session.update`; the first update stays byte-identical to today (§10.1). A rejection is detected, latched and reported, and never affects translation. |
| Transcript while in passthrough | `SttService` with engine `off` \| `openai` (pref `sttEngine`, default `off`). M7 adds `local`. |
| Their speech in passthrough | Opt-in pref `translateTheirSpeech` (default off): each final `them` STT entry is translated into the user language by the LLM before it is shown in the user language and fed to suggestions. |
| OpenAI STT | Realtime transcription WebSocket `wss://api.openai.com/v1/realtime?intent=transcription`. Default model `gpt-4o-mini-transcribe`. Commit is client-driven, using the tap's silence gate. |
| Local STT (**Deferred to M7**) | `@huggingface/transformers` **4.3.1** (pinned) in a module Web Worker in the offscreen window. WebGPU if available, otherwise multithreaded WASM. Default model `onnx-community/whisper-base` on WASM, `whisper-small` on WebGPU. The model downloads on first use and is cached. |
| Renderer origin in production | M6: unchanged (`file://`). **Deferred to M7:** pages load from a privileged custom scheme `app://renderer/…` instead of `file://`, so `fetch`, the Cache API and cross-origin isolation work in the packaged app (§7.5). The ONNX runtime WASM is bundled; no runtime code comes from a CDN. |
| PCM for STT during passthrough | A **tap** on the existing passthrough worklet (`pass-A` / `pass-B`). Zero added latency, no extra device opens. |
| LLM | One `LlmClient` for any OpenAI-compatible `/v1/chat/completions`. Presets: `openai` (`gpt-5-mini`, `reasoning_effort: minimal`), `ollama` (`http://127.0.0.1:11434/v1`), `lmstudio` (`http://127.0.0.1:1234/v1`), `custom`. |
| LLM key | Requests to `https://api.openai.com` reuse the OpenAI key from `ConfigStore`. Other hosts use an optional separate key in `userData/llmkey.bin` (safeStorage). **The OpenAI key is never sent to a non-OpenAI host, nor over plain HTTP.** |
| Token budgets | Reasoning tokens count against the cap, so budgets are generous (§6.3) and `finish_reason: 'length'` is an error (`llm-truncated`); truncated text is never spoken. |
| TTS | `POST /v1/audio/speech`, `model: gpt-4o-mini-tts`, `response_format: 'pcm'` (24 kHz s16le mono), streamed into an offscreen playback stream `tts` on the `toMeet` device. Optional headset monitor on `tts-mon`, off by default. |
| Typed speech ordering | Strict FIFO end to end: messages are spoken in the order they were sent, even if translations finish out of order. |
| Suggestions | Automatic after a final `them` utterance (debounce 1.2 s, or 0.3 s when it ends in a question mark), plus a manual "Suggest" button. Up to three replies, each in the user language plus their language. |
| Transcript window | A separate framed `BrowserWindow` (`transcript.html`), single instance, resizable, "always on top" pin, bounds clamped on screen. Opened from the bar's right-click menu, from Settings, and optionally on launch. |
| Settings | New setup route `#/assistant` (`AssistantScreen`), reached from a new row in `ReviewScreen` **and directly** from the transcript window. Passthrough keeps running while it is open. |
| Privacy | The logger redacts `text`, `original`, `translated`, `content`, `messages`, `prompt`, `instructions`, `suggestions`, `items`, `choices`, `input`. Services log event names and counts only. |

## §4 Architecture

```
                     ┌──────────────── MAIN PROCESS ──────────────────────────────────────────┐
 translate sessions  │  SessionManager ──onTranscript(dir,kind,text)──┐                       │
 (A,B, existing)     │                                                ▼                       │
                     │                ┌─────────────── AssistantRuntime (no Electron) ──────┐ │
 passthrough taps    │  SttService ───┼─▶ TranscriptAssembler / TranscriptStore ──broadcast──┼─┼─▶ transcript window
 (pass-A / pass-B)   │   └ OpenAiRealtimeStt (ws, per stream)        │ onFinal            │ │     (+ setup)
   PCM 24k ─────────▶│                                               ▼                    │ │
                     │                ├─▶ [translateTheirSpeech] ─▶ SuggestionService ─────┼─┼─▶ LLM (OpenAI / 127.0.0.1)
                     │                └─▶ SpeakController (FIFO) ─▶ LlmClient ─▶ TtsService ─┼─┼─▶ api.openai.com/v1/audio/speech
                     │                └──────────────────────────────────────────────────────┘ │
                     │  app.ts: windows, IPC, OffscreenBridge (setTap / playback)             │
                     └──────────────────────────────┬──────────────────────────────────────────┘
                                                    │ executeJavaScript / ipc
                     ┌──────────────────────────────▼──────────────────────────────────────────┐
                     │ OFFSCREEN RENDERER (file://…/offscreen.html, unchanged origin)           │
                     │  passthrough(pass-X): source ─▶ destination (native, untouched)          │
                     │                       source ─▶ worklet ─▶ meter                         │
                     │                                         └▶ tap: resample ─▶ batch ─▶ gate│
                     │                                              └ main24k: sendPcm           │
                     │  playback('tts' → CABLE-A, 'tts-mon' → headset), no backlog drop          │
                     └──────────────────────────────────────────────────────────────────────────┘
```

**Deferred to M7:** a `LocalWhisperStt` proxy in `SttService`, a `local16k` tap branch (segmenter → `whisper.worker` → result back to main), and the `app://renderer` cross-origin-isolated origin for the offscreen page.

`AssistantRuntime` (plan U11a) owns every assistant service and has no Electron imports, so it is unit-tested. `app.ts` only creates windows, wires IPC, and adapts the offscreen bridge.

### §4.1 Which transcript source is active

| App state | Direction A (`me`) | Direction B (`them`) |
|---|---|---|
| Translating, both sessions healthy | translate deltas (`source: 'translate'`) | translate deltas |
| Translating, direction X failed and runs as passthrough fallback | STT on `pass-X` if `sttEngine ≠ off` | same rule |
| Passthrough (not translating) | STT on `pass-A` if `sttEngine ≠ off` | STT on `pass-B` if `sttEngine ≠ off` |
| Passthrough with `pass-A` parked (10 min idle) | nothing (the mic is closed) | STT on `pass-B` |
| Setup wizard/review open (passthrough off) | nothing | nothing |
| Typed speech (any state, except §6.5 setup-busy) | entry `source: 'typed'` | — |

`AssistantRuntime.syncAudio()` decides this in one place. `app.ts` calls it inside `serialized()` at the end of `syncPassthrough()`, after park/wake, after assistant-pref, language, device and API-key changes, and after `onStop` (§9). `syncAudio` itself never calls `serialized()` (it runs inside it; doing so would deadlock).

## §5 Data model (`src/shared/assistant.ts`)

This section is normative for both documents.

```ts
export type Speaker = 'me' | 'them';
export type TranscriptSource = 'translate' | 'stt' | 'typed';

export interface TranscriptEntry {
  /** Stable, unique for the app lifetime. ≤ 96 chars. See §5.2. */
  id: string;
  direction: Direction;            // 'A' => me, 'B' => them
  speaker: Speaker;
  source: TranscriptSource;
  /** What was said, in the speaker's language. '' when not available. */
  original: string;
  /** Translation into the listener's language. '' when not available (yet). */
  translated: string;
  originalLang: LanguageCode;
  translatedLang: LanguageCode;
  startedAt: number;               // epoch ms of first text
  updatedAt: number;               // epoch ms of last change
  /** No more text will be appended (a late translation may still be patched in, §6.1). */
  final: boolean;
  /** Typed entries only. */
  speak?: SpeakStatus;
}

export type SpeakStatus = 'queued' | 'translating' | 'synthesizing' | 'speaking' | 'done' | 'error' | 'cancelled';

export interface Suggestion { text: string; translation: string }   // user language / their language ('' if omitted)

export interface SuggestionsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  forEntryId?: string;             // undefined for manual requests
  items: Suggestion[];
  errorCode?: AssistantErrorCode;
  updatedAt: number;
}

export type AssistantErrorCode =
  | 'no-openai-key'                // TTS or OpenAI STT without key
  | 'llm-unreachable'              // ECONNREFUSED / DNS / network (Ollama not running)
  | 'llm-auth'                     // 401/403
  | 'llm-model-missing'            // 404, "model not found", or empty model name
  | 'llm-timeout'
  | 'llm-bad-response'             // unparseable or empty content
  | 'llm-truncated'                // finish_reason 'length'
  | 'tts-failed'
  | 'tts-no-device'                // toMeet device not configured
  | 'tts-busy-setup'               // setup wizard/review is using the devices
  | 'stt-failed'
  // M7 adds 'stt-model-download-failed' (local model)
  | 'input-transcript-unsupported' // translate endpoint rejected audio.input.transcription
  | 'rate-limited'                 // 429
  | 'unknown';

export interface SttStatus {
  engine: SttEngine;
  state: 'off' | 'listening' | 'error';
  streams: Direction[];            // directions being transcribed now
  errorCode?: AssistantErrorCode;
  // M7 (local engine) adds: state 'loading-model' | 'ready'; progress?: number (0..1);
  // backend?: 'webgpu' | 'wasm'; behind?: boolean (dropped utterances in the last 30 s)
}

/** What the transcript window needs besides prefs; pushed on change. */
export interface AssistantContext {
  langs: { user: LanguageCode; them: LanguageCode };
  translating: boolean;
  hasOpenAiKey: boolean;
  hasToMeetDevice: boolean;
  setupBusy: boolean;              // setup wizard/review owns the devices: typed speech refused
}

export interface SpeakArgs { text: string; translate: boolean; translation?: string }
```

Mapping rules:

- Translate delta, direction A: kind `input` → `me.original`, kind `output` → `me.translated`. Direction B: `input` → `them.original`, `output` → `them.translated`.
- STT segment on `pass-A` → `me.original`; on `pass-B` → `them.original`. `translated` stays `''` unless `translateTheirSpeech` patches it (them only).
- Typed entry: `me`, `original` = typed text, `translated` = LLM translation.
- A spoken suggestion creates a typed entry with `original` = suggestion text and `translated` = suggestion translation (no second LLM call when the translation is present).

### §5.1 Prefs (`UserPrefs.assistant`, `UserPrefs.transcriptWindow`)

```ts
export type SttEngine = 'off' | 'openai';   // M7 adds 'local'
export type LlmPreset = 'openai' | 'ollama' | 'lmstudio' | 'custom';
export type ReasoningEffort = '' | 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface AssistantPrefs {
  sttEngine: SttEngine;                   // default 'off'
  sttOpenAiModel: string;                 // default 'gpt-4o-mini-transcribe'
  // M7 adds whisperModel: WhisperModel | 'auto' (WhisperModel = 'whisper-base' | 'whisper-small' | 'whisper-large-v3-turbo')
  translateInputTranscript: boolean;      // default false (applies from the next Start)
  translateTheirSpeech: boolean;          // default false
  llm: { preset: LlmPreset; baseUrl: string; model: string; reasoningEffort: ReasoningEffort };
  ttsVoice: string;                       // default 'alloy'
  ttsModel: string;                       // default 'gpt-4o-mini-tts'
  ttsMonitor: boolean;                    // default false
  suggestionsEnabled: boolean;            // default true
  autoSuggest: boolean;                   // default true
  transcriptOpenOnLaunch: boolean;        // default false
}

export interface TranscriptWindowPrefs { x?: number; y?: number; width: number; height: number; alwaysOnTop: boolean } // 420×640, false

export const LLM_PRESETS: Record<LlmPreset, { baseUrl: string; model: string; reasoningEffort: ReasoningEffort }> = {
  openai:   { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', reasoningEffort: 'minimal' },
  ollama:   { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b',   reasoningEffort: 'none' },
  lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1',  model: '',           reasoningEffort: '' },
  custom:   { baseUrl: '',                          model: '',           reasoningEffort: '' },
};
```

- Presets use `127.0.0.1`, not `localhost`: Node's fetch can resolve `localhost` to `::1` while Ollama binds IPv4 only.
- On disk `prefs.assistant` is partial. `resolveAssistantPrefs` fills defaults and drops invalid values (an unknown `sttEngine` such as `'local'` becomes `'off'`); it never throws.
- Writes go through `PrefsSetAssistant(patch)`, validated by `isAssistantPrefsPatch`, deep-merging `llm`.
- Validation: `baseUrl` parses as `http:`/`https:` and is ≤ 200 chars; `model` ≤ 100 chars; `ttsVoice` matches `/^[a-z0-9_-]{1,40}$/`; `reasoningEffort` is one of the `ReasoningEffort` values; enums checked; unknown keys rejected.
- An empty `model` is allowed in prefs (LM Studio/custom start empty), but every LLM call fails fast with `llm-model-missing` before any request.

### §5.2 Entry ids

Ids must never be reused while the app runs, because `TranscriptStore.upsert` replaces by id.

| Source | Id |
|---|---|
| translate | `tr-${direction}-${seq}`, `seq` monotonic per assembler (never reset) |
| OpenAI STT | `stt-${streamId}-${itemId}` (server item ids are unique) |
| local STT (**Deferred to M7**) | `stt-${streamId}-${bootId}-${seq}`; `bootId` = 8 random hex chars generated once per offscreen page load; `seq` one counter for the whole page lifetime, never reset |
| typed | `typed-${8 random hex}` |

## §6 Main-process services

All services live under `src/main/<area>/`, have no Electron imports, and take I/O by injection (`fetch`, `wsFactory`, `now`, timers, offscreen ports, logger). Exact signatures: plan U3–U6 and U11a.

### §6.1 Transcript assembler and store (`src/main/transcript/`)

Translate deltas are finalized segments with no utterance boundary (§10.1), so the **assembler** decides where an utterance ends. Per direction there is at most one *open* entry; input and output deltas of the same direction go into that same entry. It tracks `lastInputAt` and `lastOutputAt` separately.

Joining: a delta is appended with one space unless the previous text is empty or ends in whitespace, the delta starts with whitespace or `,.;:!?…)]}'"`, or either side is CJK.

An open entry becomes `final` when one of these holds:

1. **Idle.** `now − max(lastInputAt, lastOutputAt) ≥ FINALIZE_IDLE_MS (1800)`, **and** the entry is not waiting for its translation. It is *waiting* when `original` is non-empty, `translated` is empty, and `now − lastInputAt < OUTPUT_LAG_MS (4000)`. (Output arrives 1–3 s after input.)
2. **Long entry.** The entry is older than `LONG_ENTRY_MS (30000)`, its `translated` text ends in `.?!…。？！`, and `now − lastInputAt ≥ 1800` (or no input was ever received). This keeps the output tail of a sentence in the same entry.
3. **Stop.** Translation stops (`finalizeAll()`).

**Late output.** An output delta that arrives when direction X has no open entry is attached to X's most recently finalized entry if it was finalized less than `LATE_OUTPUT_MS (3000)` ago and its `translated` is still empty. The store updates the entry (`onFinal` does not fire again). Otherwise it opens a new entry.

The **store** keeps a 500-entry ring buffer (drops oldest), replaces by id, fires `onFinal` exactly once per id when `final` flips to true, supports `get(id)`, `patch(id, p)`, `snapshot()`, `recent({maxEntries, maxChars, finalOnly})` and `clear()`. `recent` skips entries with no text and counts characters as `original.length + translated.length`.

A 500 ms tick runs the assembler's idle rules only while translating.

**Export** (`transcriptExport.ts`, pure): header `Transcript — <date>`, then one line per entry `[HH:MM:SS] Me: original — translated` (Markdown: `# ` header, bold speakers). `app.ts` shows the save dialog and writes the file. Export is the only time transcript content reaches disk.

### §6.2 `SttService` (`src/main/stt/`)

Converges "which streams are transcribed with which engine" into running engine instances.

- Engines in M6: `off` and `openai` only. The engine → tap-mode mapping lives in one table (`openai → main24k`) so M7 adds `local → local16k` there.
- Diff key per stream: `streamId | engine | model | lang`, where `model` is the OpenAI model (M7: or the local whisper model pref). Changing any of them restarts that stream.
- **Only `SttService` calls `setTap`.** Start: create the engine instance, then `setTap(streamId, 'main24k', {model, lang}, onPcm)`. Stop: `setTap(streamId, 'off')`, then `instance.stop()`. If `setTap` throws, the instance is stopped and the status becomes `error`/`stt-failed`.
- Calls are serialized internally. `stopAll()` stops everything.
- `retry()` stops every instance and re-runs the last `sync`. It backs the Retry button. (M7: also asks the offscreen side to reload the local model when the engine is `local`.)
- Status (pushed on every change): `off` with no instances; otherwise `listening`. An engine `onError(code)` sets `state: 'error'` with that code. (M7: latest local worker state, and `behind: true` for 30 s after a `dropped` notice.)
- Segments become entries through the pure `sttSegmentToEntry(prev, seg, langs, now)` (returns `undefined` for an empty segment with no previous entry). A `failed` item finalizes any existing entry for that item.

#### §6.2.1 OpenAI realtime transcription

- Opens `wss://api.openai.com/v1/realtime?intent=transcription` with `Authorization: Bearer <key>` (no beta header).
- With no OpenAI key, the factory reports `no-openai-key` through `onError` and returns a no-op instance; nothing connects.
- After `onopen` it sends (protocol module `openaiSttProtocol.ts`):

```json
{"type":"session.update","session":{"type":"transcription","audio":{"input":{
  "format":{"type":"audio/pcm","rate":24000},
  "transcription":{"model":"<sttOpenAiModel>","language":"<lang>"},
  "noise_reduction":{"type":"near_field"},
  "turn_detection":null}}}}
```

  - `gpt-live-transcribe` gets `"languages":["<lang>"]` instead of `"language"`.
  - Direction A sends `near_field`; direction B (already processed by the call app) sends `noise_reduction: null`.
- Each PCM chunk from the tap becomes `input_audio_buffer.append`.
- **Commit.** The tap's gate (hangover 400 ms, then a 500 ms zero tail) sends nothing while closed. When no chunk arrived for `COMMIT_IDLE_MS = 350` and at least 200 ms of audio (bytes / 2 / 24000 × 1000) was appended since the last commit, the engine sends `input_audio_buffer.commit`. It also forces a commit at `MAX_SEGMENT_MS = 15000` of uncommitted audio. Expected end-of-speech → commit ≈ 1.25 s, then transcription.
- **Events** (`parseSttEvent`, pure): `…input_audio_transcription.delta` → append segment; `…completed` → replace segment, final; `…failed` → final empty segment for that item, log `stt_item_failed`; `error` → log `stt_server_error {code,type,param}` (no message), and `onError('stt-failed')` if fatal (`invalid_request_error` or `invalid_api_key`; no reconnect then).
- **Reconnect.** `ExponentialBackoff` (1 s base / 30 s cap / 5 attempts). The backoff and attempt counter **reset on every successful open**, so periodic server-side session expiry never exhausts it. Pending PCM before open is capped at 100 chunks and dropped on reconnect.
- **UNVERIFIED (isolated in `openaiSttProtocol.ts`):** the exact GA `session.update` shape, `turn_detection: null`, and `language` vs `languages`. A rejection is logged as `stt_session_rejected {code, param}` and reported as `stt-failed`.

#### §6.2.2 Local Whisper (main-side proxy) — **Deferred to M7**

Not implemented in M6; kept as the M7 design.

- Recognition runs in the offscreen worker (§7.3). The factory only registers a result callback for the stream on create and unregisters it on stop. It does **not** call `setTap`.
- Results arrive on `OFFSCREEN_IPC.SttResult` `{streamId, bootId, seq, text, final: true, durationMs}` and become a final `replace` segment with id `${streamId}-${bootId}-${seq}`. Empty text is ignored.
- Worker messages arrive on `OFFSCREEN_IPC.SttStatus` as either `{kind:'state', …}` (model loading/ready/error, backend) or `{kind:'dropped', streamId, n}`. They are separate kinds so a drop never overwrites the loading state.

### §6.3 `LlmClient` (`src/main/llm/`)

One client for any OpenAI-compatible `/chat/completions`.

**Config** is read per call: `{baseUrl, model, apiKey?, reasoningEffort}`.

**Key selection** (`selectLlmKey(baseUrl, openAiKey, customKey)`, pure, unit-tested):

- `isOpenAiHost(baseUrl)` is true only when protocol is `https:`, hostname is `api.openai.com`, and port is empty or `443`.
- OpenAI host → `openAiKey ?? customKey`. Any other URL (including `http://api.openai.com`) → `customKey` only.

**Request body** (`buildChatBody`, pure):

- OpenAI host: `{model, messages, max_completion_tokens, reasoning_effort?}`; no `temperature`.
- Other hosts: `{model, messages, max_tokens, temperature: 0.3, reasoning_effort?}`.
- `reasoning_effort` only when non-empty. `jsonSchema` → `response_format: {type:'json_schema', json_schema:{name, strict:true, schema}}`.

**Retries** (each at most once per call):

- 400 whose body mentions `response_format|json_schema` while a schema was sent → retry without it.
- 400 whose body mentions `reasoning|think` while `reasoning_effort` was sent → retry without it (some Ollama models).

**Budgets** (reasoning tokens count against the cap):

| Call | Cap |
|---|---|
| Suggestions | 2000 |
| Translation | `min(6000, ceil(chars / 2) + 1000)` |
| Their-speech translation | same formula |
| Connection test | 512 |

**Timeouts:** 30 s for an OpenAI host, 90 s otherwise (a local model's cold load can exceed 30 s). The Test button uses 20 s / 120 s, so it also warms a local model.

**Response handling:**

- An empty `model` throws `llm-model-missing` before any request.
- `choices[0].finish_reason === 'length'` → `llm-truncated` (the text is never used).
- `choices[0].message.content` must be a string; `<think>…</think>` blocks are stripped; an empty result → `llm-bad-response`.
- Streaming (`stream()`, SSE via the pure `parseSseChunk`) exists for later use; v1 callers use `complete()`.
- `listModels()` → `GET {baseUrl}/models` → sorted `data[].id`. On an OpenAI host it keeps chat-capable ids only (`/^(gpt-|o\d|chatgpt)/` and not `/(audio|realtime|transcribe|tts|image|search|embedding)/`).

**Error mapping** (pure): thrown `TypeError` / `ECONNREFUSED` / `ENOTFOUND` / `ECONNRESET` → `llm-unreachable`; 401/403 → `llm-auth`; 404 or `/model.*(not found|does not exist)/i` → `llm-model-missing`; 429 → `rate-limited`; timeout abort → `llm-timeout`; else `unknown`. A caller abort is rethrown as `AbortError` and ignored by callers.

**Logging:** `llm_request_done {status, ms, model, finish}` and `llm_request_failed {code, status}`. Never messages or content.

**Prompts** (`prompts.ts`, pure, unit-tested):

- `buildTranslatePrompt(text, from, to)`: system `You translate chat messages for a live voice call. Translate the user's message from <From> to <To>. Keep the tone and register, keep names/numbers, do not add anything. Output only the translation.`; user: the text. When `from === to` callers skip translation.
- `buildSuggestionPrompt(entries, langs)`: system `You help <UserLangName> speaker "Me" in a live call with "Them" (who speaks <ThemLangName>). Based on the conversation, propose up to 3 short, natural replies Me could say next — especially if Them just asked a question. Each reply: max 2 sentences. Return JSON {"suggestions":[{"text":"<reply in <UserLang>>","translation":"<same reply in <ThemLang>>"}]}. If no reply is needed, return {"suggestions":[]}.`; user: transcript lines oldest → newest, `Them: translated || original`, `Me: original || translated`, bounded by 30 entries / 6000 chars from the oldest.
- `parseSuggestions(raw)` (pure): code fence strip → `JSON.parse` → balanced-brace scan → numbered/bulleted lines. Drops empty `text`, keeps at most 3, accepts a bare array of strings.

### §6.4 `SuggestionService`

- Triggers: a final `them` entry when `suggestionsEnabled && autoSuggest` and its text (`translated || original`) has ≥ 2 words. Debounce 1200 ms, or 300 ms when that text ends in `?` or `？`. Manual `requestNow()` ignores `autoSuggest` and the word rule.
- One request in flight; a new trigger aborts the old one; a late result of an aborted request is ignored (sequence number).
- A final `me` entry with `source !== 'typed'` and ≥ 2 words clears `ready` suggestions to `idle` (the user answered by voice). Typed entries, including spoken suggestions, do not clear them, and neither does keyboard noise.
- Errors → `status: 'error'` with the code. No automatic retry.
- With `translateTheirSpeech` on, the runtime passes a `them` STT entry to the service only after its translation is patched in (or failed), so the model reads the user language.

### §6.5 `TtsService` (`src/main/tts/`)

- Request: `POST https://api.openai.com/v1/audio/speech` with `{model, voice, input, response_format:'pcm', instructions?}`. `instructions` (`Speak naturally in <LangName>, at a conversational pace.`) only for `gpt-4o-mini-tts*` models.
- Checks before any request, in order: setup busy → `tts-busy-setup`; no key → `no-openai-key`; no `toMeet` device → `tts-no-device`; input > 4096 chars → `tts-failed` (log `tts_input_too_long`).
- Strict FIFO queue, one item at a time. The response body is streamed through `PcmStreamChunker` (exact 4800-byte = 100 ms chunks, odd-byte carry) into `tts` (and `tts-mon` when monitor is on and a headset is set). `onFirstAudio` fires on the first chunk.
- **Done.** The item resolves at `firstPushAt + totalSamples / 24000 × 1000 + 300 ms` (not measured from the last chunk, which would add the download time).
- Streams stay open between items and close after 30 s idle, on `stopAll()`, on a device change, on a `toMeet`/headset pref change, and when the offscreen reports a `tts*` stream event.
- Errors: HTTP 429 → `rate-limited`; other HTTP errors or a null body → `tts-failed`.
- Logging: `tts_done {chars, ms, samples}`, `tts_failed {code, status?}`.

Playback opens with `{maxBacklogS: 120, catchup: false}` because TTS arrives faster than real time (§7.2).

### §6.6 `SpeakController`

1. `speak(args)` validates, creates a typed `me` entry (`final: true`, `speak: 'queued'`) and returns its id immediately.
2. Each request is appended to **one promise chain**, so translate → TTS runs strictly in submission order.
3. When its turn comes: `translating` (skipped if `translation` was given, if `!translate`, or if user language = their language) → `llm` translation with the §6.3 budget, patched into `translated` → `synthesizing` → `speaking` on first audio → `done`.
4. Any error → `speak: 'error'` and `AssistantError {scope:'speak', code}`. Truncated or empty translations are errors and are never spoken.
5. `stop()` aborts the running item and empties the chain; every unfinished entry becomes `cancelled` (shown without Retry styling as an error).
6. The entry is `me` and typed, so it never triggers or clears suggestions.

## §7 Offscreen changes

### §7.1 Passthrough PCM tap

- `startPassthrough` returns a handle with `setTap(tap | null)`, switchable at runtime: changing the STT engine never restarts the audio route.
- In the worklet's `port.onmessage`, after `meter.push`: `Resampler(ctx.sampleRate → rate)` → `FrameBatcher(rate × 0.04)` → `SilenceGate({sampleRate: rate, hangoverMs: 400, tailMs: 500})` → sink, all in try/catch so a tap error never breaks the meter or the route. The native route (`source → destination`) is untouched.
- **Resampler** (pure): Blackman-windowed sinc FIR, **64 taps**, cutoff `0.4 × min(from, to)`, then fractional-phase linear interpolation with state across blocks. Over a long run the output length is `floor(totalIn × to / from) ± 1`.
- **`main24k` sink:** PCM16 base64 → `offscreenBridge.sendPcm(streamId, b64)` (existing channel). This is the only sink in M6, and the reason the `Resampler` is built in M6 (`ctx.sampleRate` → 24 kHz).
- **`local16k` sink (Deferred to M7):** `UtteranceSegmenter` (pure) emits an utterance after ≥ 300 ms of gate silence or at 28 s; utterances with < 400 ms of non-silent audio are dropped; trailing silence is trimmed to 100 ms. A 250 ms interval flushes when no frame arrived for 300 ms.
- The tap mode is a setting kept in `taps: Map<streamId, {mode, opts}>` and re-applied in `startPassthrough`, so it survives restarts, park/wake and recovery.
- `setPassthroughTap(streamId, mode, opts)` **returns immediately** (never awaits anything slow; in M7 model loading is asynchronous and reported through status messages), so the 15 s exec timeout can never fire inside the serialized lifecycle.

### §7.2 Playback options

`startPlaybackWithOptions(streamId, deviceId, {maxBacklogS?, catchup?})` (a separate method; the existing `startPlayback` is unchanged). Defaults keep today's 6 s / 1.06× behaviour; TTS uses 120 s / no catch-up.

### §7.3 Whisper worker — **Deferred to M7**

Not implemented in M6 (no transformers.js / onnxruntime-web dependency, no worker, no hallucination filter); kept as the M7 design.

- Created lazily on the first `local16k` tap as a module worker; disposed when no `local16k` tap remains.
- In: `{type:'load', model}`, `{type:'transcribe', streamId, seq, lang, audio}` (transferable). Out: `{type:'status', state, progress?, backend?, detail?}`, `{type:'dropped', streamId, n}`, `{type:'result', streamId, seq, text, durationMs}`.
- Backend: WebGPU when a GPU adapter is available, else WASM. WASM uses `numThreads = min(4, hardwareConcurrency − 1)` when `crossOriginIsolated`, else 1.
- **ONNX runtime files are bundled** (Vite `?url` imports of the `onnxruntime-web` dist files) and `env.backends.onnx.wasm.wasmPaths` points at them. Nothing is loaded from a CDN; main additionally cancels any request to `cdn.jsdelivr.net` and logs `blocked_cdn_request`.
- Model: `'auto'` → `whisper-small` on WebGPU, `whisper-base` on WASM; repo `onnx-community/<name>`; dtype `{encoder_model:'fp32', decoder_model_merged:'q4'}` on WebGPU, `'q8'` on WASM (**UNVERIFIED** for 4.3.1; checked by U8b).
- Call options: `{language: <ISO code>, task: 'transcribe', return_timestamps: false}`. The ISO 639-1 code from `LanguageCode` is passed directly (Whisper's tokenizer accepts codes); no name mapping.
- **Backpressure:** per-stream queue cap 2 (drop that stream's oldest, report `dropped`); B (`them`) is processed before A, because their questions drive suggestions.
- **Model cache:** browser Cache API in the `app://renderer` origin (works because the scheme is standard and secure, §7.5). `reload` disposes the pipeline so the next `load` refetches.
- **Hallucination filter** (pure `whisperFilter.ts`): empty or punctuation-only text; known silence phrases (`thank you`, `thanks for watching`, `grazie`, `grazie a tutti`, `obrigado`, `obrigada`, `sottotitoli creati dalla comunità amara.org`, `you`, `[music]`, `(music)`, `♪`) on utterances under 1 s; a token repeated more than 6 times.
- **UNVERIFIED:** WebGPU in a hidden `BrowserWindow` on Electron 42; the exact onnxruntime-web dist file names for the pinned version; HF CDN responses under COEP `require-corp` (fallback: `credentialless`).

### §7.4 Stream ids and recovery

- New stream ids `tts`, `tts-mon`. STT taps reuse `pass-A`/`pass-B` and open no streams.
- `onStreamEvent` must not call `scheduleRecovery` (or health) for ids starting with `tts`; it stops TTS instead.
- `onDeviceChange` also stops TTS (closing the memoised streams), so CABLE-A re-enumeration never leaves TTS writing into a dead endpoint.

### §7.5 Production origin: `app://renderer` — **Deferred to M7**

Not implemented in M6: every page, including the new `transcript.html`, keeps loading from `file://` in production and `isAppUrl` is unchanged. Nothing in M6 needs `fetch` of local files, the Cache API or cross-origin isolation; only local Whisper does. Kept as the M7 design:

Chromium refuses `fetch()` of `file:` URLs, and a `file://` page has an opaque origin where the Cache API is unavailable. onnxruntime-web loads its WASM through `fetch`, and transformers.js caches models through the Cache API. So in production every renderer page loads from a privileged scheme:

- `protocol.registerSchemesAsPrivileged([{scheme:'app', privileges:{standard:true, secure:true, supportFetchAPI:true, corsEnabled:true, stream:true}}])` at module load, before `app.whenReady`.
- `protocol.handle('app', …)` serves files under `out/renderer` for host `renderer` only, rejects path traversal and other hosts with 404, and adds `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` to every response (pages, scripts, workers, wasm).
- Page URLs become `app://renderer/<page>.html`. `isAppUrl` accepts exactly that origin in production (and the dev-server origin in dev). The navigation guard and `isTrustedSender` use it unchanged.
- In dev the Vite server sends the same COOP/COEP headers.
- Must be verified in the **packaged** build (U12), not only in dev.

## §8 IPC surface

Constants in `src/shared/events.ts`, types in `src/main/ipc/channels.ts`, preload methods in `src/main/preload.ts`. Every invoke validates its args with a guard and throws `Error('invalid-args')` on failure, and passes `isTrustedSender`, which now includes the transcript window.

| Constant | Channel | Kind | Args → Result |
|---|---|---|---|
| `OpenTranscriptView` | `window:openTranscriptView` | invoke | `void → void` |
| `OpenAssistantSettings` | `window:openAssistantSettings` | invoke | `void → void` |
| `TranscriptGet` | `transcript:get` | invoke | `void → TranscriptEntry[]` |
| `TranscriptClear` | `transcript:clear` | invoke | `void → void` |
| `TranscriptExport` | `transcript:export` | invoke | `{format:'txt'\|'md'} → {saved: boolean}` |
| `TranscriptSetAlwaysOnTop` | `transcript:setAlwaysOnTop` | invoke | `{value: boolean} → void` |
| `PrefsSetAssistant` | `prefs:setAssistant` | invoke | `AssistantPrefsPatch → AssistantPrefs` |
| `LlmKeyGetHint` | `config:llmKeyHint` | invoke | `void → string \| undefined` (last 4) |
| `LlmKeySet` | `config:llmKeySet` | invoke | `{value: string} → void` |
| `LlmKeyClear` | `config:llmKeyClear` | invoke | `void → void` |
| `LlmTest` | `assistant:llmTest` | invoke | `void → {ok:true, ms} \| {ok:false, code}` |
| `LlmListModels` | `assistant:llmListModels` | invoke | `void → {ok:true, models} \| {ok:false, code}` |
| `SpeakText` | `assistant:speak` | invoke | `SpeakArgs → {entryId: string}` |
| `SpeakStop` | `assistant:speakStop` | invoke | `void → void` |
| `SuggestNow` | `assistant:suggestNow` | invoke | `void → void` |
| `SuggestionsGet` | `assistant:suggestionsGet` | invoke | `void → SuggestionsState` |
| `SttStatusGet` | `assistant:sttStatusGet` | invoke | `void → SttStatus` |
| `SttRetry` | `assistant:sttRetry` | invoke | `void → void` |
| `AssistantContextGet` | `assistant:contextGet` | invoke | `void → AssistantContext` |
| `TranscriptEntry` | `transcript:entry` | send | `TranscriptEntry` |
| `TranscriptCleared` | `transcript:cleared` | send | `void` |
| `SuggestionsChanged` | `assistant:suggestions` | send | `SuggestionsState` |
| `SttStatusChanged` | `assistant:sttStatus` | send | `SttStatus` |
| `AssistantError` | `assistant:error` | send | `{scope:'speak'\|'suggest'\|'stt'\|'llm', code}` |
| `AssistantPrefsChanged` | `assistant:prefsChanged` | send | `AssistantPrefs` |
| `AssistantContextChanged` | `assistant:contextChanged` | send | `AssistantContext` |

Guards: `isSpeakArgs` (`text` 1..2000 chars after trim, `translate` boolean, `translation?` ≤ 4096), `isAssistantPrefsPatch`, `isExportArgs`, `isLlmKeyArgs` (1..300 chars), `isAlwaysOnTopArgs`. The legacy `TranscriptDelta` broadcast stays.

`handlers.ts` gains one optional hook `onPrefsChanged(what: 'languages' | 'devices' | 'apiKey')`, called after a successful `PrefsSetLanguages`, `PrefsSetDevices`, `SetApiKey` or `ClearApiKey`. `app.ts` uses it to refresh the runtime's caches, stop TTS on a device change, re-run `syncAudio`, and push `AssistantContextChanged`.

## §9 `app.ts` integration rules

- **Protocol:** none in M6; `TRANSCRIPT_URL` follows the existing `file://` / dev-server pattern. (The §7.5 protocol is deferred to M7.)
- **Transcript window:** singleton framed window, 420×640 (min 320×360), `backgroundColor '#08090a'`, preload `preload.cjs`, `alwaysOnTop` from prefs at level `'floating'`, saved bounds clamped to a visible display work area, bounds saved with a 300 ms debounce. It is added to `broadcast`, `isTrustedSender`, the navigation guard and the external-link handler. It does not count in `quitIfNoVisibleWindow`; it closes with the app.
- **Bar menu:** new first item `menu.transcript`.
- **Startup:** if `transcriptOpenOnLaunch` and setup is complete, open it after the bar.
- **Settings without killing the call:** `setupNeedsDevices()` returns false for `#/troubleshoot` and `#/assistant`. `OpenAssistantSettings` opens or re-targets the setup window on `#/assistant` (generalizing `openTroubleshooting`).
- **`syncAudio`** is called inside `serialized()` at the end of `syncPassthrough()`, after park and wake, after `PrefsSetAssistant`, after the `onPrefsChanged` hook, and after `onStop`. The audio state it reads: `translating`, `langs`, TTS devices (`activeArgs` while translating, prefs otherwise), the running passthrough directions (`failedDirections` while translating; active `pass-*` minus parked A otherwise), and `setupBusy = setupNeedsDevices()`.
- **`onStart`:** STT stops for both directions before the manager starts (`syncAudio` with translating = true and no failed directions). The `SessionManager` config gets `inputTranscriptionModel: 'gpt-realtime-whisper'` when `translateInputTranscript` is on, and an `onInputTranscriptionRejected` callback.
- **`onStop`:** `finalizeAll()`, then `syncPassthrough()` (which re-syncs STT).
- **`emitTranscript`:** keeps the legacy broadcast and also feeds the assembler.
- **`runDiagnostics`:** stops STT and TTS first; its `finally` re-syncs.
- **`before-quit`:** disposes the runtime (stops speech, STT, suggestions, the tick).
- **Serialization:** device-touching work runs in `serialized()`. `speak` does not; its sink `open()` is memoised.
- **CDN block (Deferred to M7):** `session.defaultSession.webRequest.onBeforeRequest({urls:['*://cdn.jsdelivr.net/*']}, …)` cancels and logs. It only guards the onnxruntime WASM loader, so it ships with local Whisper.

## §10 External API facts and isolation

### §10.1 Translate endpoint transcripts

- `session.input_transcript.delta` / `session.output_transcript.delta` are already handled in `openaiSession.ts`. Deltas are finalized segments, never revised; there are no `.done` events, hence idle finalize.
- The existing comment in `openaiSession.ts` says this endpoint rejects unknown session params. Whether it accepts `audio.input.transcription` is **UNVERIFIED**. Therefore:
  - The first `session.update` stays **byte-identical** to today's, with or without the option.
  - With `inputTranscriptionModel` set, a **second** `session.update` follows: `{audio:{output:{language, voice?}, input:{transcription:{model}}}}`. It repeats `output` so the result is correct whether the server merges or replaces session fields.
  - An `error` event whose `param` or `message` matches `/audio\.input|transcription/i` while that option is active is a rejection: log `input_transcription_rejected {code, param}`, latch it for the session object (reconnects do not resend), do **not** record it as `lastServerErrorMessage`, and call `onInputTranscriptionRejected`. The runtime pushes `AssistantError {scope:'stt', code:'input-transcript-unsupported'}`. Translation continues untouched.
- **UNVERIFIED:** whether output transcripts are emitted unconditionally (the code handles them today).

### §10.2 Cost notes (user-facing copy in Settings)

| Feature | Cost |
|---|---|
| Transcript while translating | Output transcripts come with the translation (**UNVERIFIED** whether billed separately). The source-language option may add about $0.017/min per direction (**UNVERIFIED**). |
| Passthrough STT, OpenAI | `gpt-4o-mini-transcribe` $0.003/min of *gated* audio; `gpt-4o-transcribe` $0.006/min; `gpt-live-transcribe` $0.017/min. |
| Passthrough STT, local (**M7**) | Free. One-time download of about 80–1600 MB. Not shown in M6. |
| Their-speech translation | One small LLM call per utterance (OpenAI: fractions of a cent; local: free). |
| TTS | `gpt-4o-mini-tts`: $0.60 / 1M text tokens + $12 / 1M audio tokens. |
| LLM | `gpt-5-mini` ($0.25 in / $2.00 out per 1M): a suggestion call ≈ $0.001–0.004. Local models free. |

## §11 UI

### §11.1 Transcript window (`src/renderer/transcript.html`)

1. **Header:** status dot + text (`Translating` / `Direct audio + transcription (OpenAI)` / `Transcription off` / error with a **Retry** button → `SttRetry`; M7 adds Local, downloading % and `behind`); pin toggle; menu (Clear with confirm, Export .txt, Export .md, Assistant settings → `OpenAssistantSettings`). "Translating" comes from `AssistantContext.translating`, fetched on mount and pushed on change (no reliance on a state change after the window opens).
2. **Call to action** when not translating and `sttEngine === 'off'`: a "Transcribe with OpenAI" button that sets `sttEngine: 'openai'` in one click (disabled with the no-key hint without an OpenAI key), with the cost note. (M7 adds "Transcribe on this PC".)
3. **Transcript list:** bubbles (`me` right/accent, `them` left/surface); primary line in the user language (`them.translated || them.original`, `me.original || me.translated`), secondary line the other language; caret on non-final entries; time on hover; typed entries show a keyboard badge and speak status (Retry on `error`, none on `cancelled`); sticky-bottom scroll with a "Jump to latest" chip.
4. **Suggestions panel** (hidden when disabled): up to 3 cards; click → copy into the composer; Speak → `speakText({text, translate:false, translation})`, or `translate:true` when the translation is empty; "Suggest" button; shimmer; error line via `assistant.errors.<code>`; a hint when passthrough has no transcription.
5. **Composer:** textarea (Enter sends, Shift+Enter newline, Enter ignored while `isComposing`), max 2000 chars with counter; "Translate to <lang>" toggle (hidden when languages are equal); Send / Stop; hints from `AssistantContext` (no key, no device, setup busy).

State: pure reducer `transcriptReducer` (unit-tested). The subscription hook subscribes first, then fetches snapshots (`getTranscript`, `getSuggestions`, `getSttStatus`, `getAssistantContext`, prefs); a push that arrived during the fetch wins. `document.documentElement.lang` is set from the resolved UI locale.

### §11.2 Assistant settings (`#/assistant`)

1. **Live transcript:** engine radio (Off / OpenAI); OpenAI model select; the STT status and a Retry button on error (M7 adds the Local choice and a local model select with sizes and download progress); "Also transcribe original speech while translating" (cost note + "applies from the next Start"); "Translate what they say when not translating"; "Open transcript window at launch"; "Open transcript now".
2. **AI model:** preset segmented control (fills `baseUrl`/`model`/`reasoningEffort`; `custom` keeps the current URL/model); Base URL; Model with "Load models" (datalist; empty/failed messages); Reasoning effort select (the `ReasoningEffort` values); API key (non-OpenAI hosts only; save/clear; last-4 hint); Test connection (✓ ms, or the mapped error with a hint such as "Ollama is not running — start it and run `ollama pull <model>`"); cost note; insecure-URL warning for `http:` non-loopback.
3. **Voice:** voice select (alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse, marin, cedar), headset monitor checkbox with the echo warning, cost note.
4. **Reply suggestions:** enabled, automatic, hint.

Every change saves immediately. `ReviewScreen` gets a 7th row "Assistant" → `#/assistant`.

### §11.3 Bar menu

New first item `menu.transcript` ("Live transcript").

## §12 Security and privacy

- Redacted log keys as in §3; `input` is not used as a log key today; `message` stays unredacted and new code never puts content in it. Logger test asserts the new keys are dropped.
- The OpenAI key goes only to `https://api.openai.com[:443]` (unit-tested, including the `http://api.openai.com` case).
- The custom LLM key is stored with safeStorage in `llmkey.bin` and never returned to a renderer (last 4 only).
- Transcript content stays in main memory and renderer state; Clear empties both; Export is the only disk write.
- No runtime code from CDNs (M6 adds no third-party runtime code). **Deferred to M7:** the custom protocol serving only files under the renderer output directory (path traversal rejected, unit-tested) and the jsdelivr block.
- `http:` base URLs on non-loopback hosts are allowed but warned about in Settings.
- There is no CSP today; if one is added, `connect-src` must allow `https://api.openai.com` and `http://127.0.0.1:*` (M7 also `https://huggingface.co` and its CDN hosts, and `script-src` `'wasm-unsafe-eval'` on the offscreen page).

## §13 Error handling and offline behaviour

| Situation | Behaviour |
|---|---|
| Ollama / LM Studio not running | `llm-unreachable`; inline error; the composer still speaks untranslated text if "Translate" is unticked. |
| Model missing / empty | `llm-model-missing` with a hint to pull it or use "Load models". |
| Reasoning budget exhausted | `llm-truncated`; nothing is spoken. |
| No OpenAI key | TTS and OpenAI STT report `no-openai-key`; a local LLM still works (translate-delta transcript needs the key anyway). Adding the key re-syncs STT immediately (`onPrefsChanged('apiKey')`). |
| Offline | OpenAI STT backs off and reports `stt-failed`; Retry re-syncs. Passthrough audio unaffected. |
| Whisper download fails (**M7**) | `stt-model-download-failed`; Retry reloads the model. |
| Slow local Whisper (**M7**) | Per-stream drops; `behind` shown in the header for 30 s. |
| TTS without toMeet device | `tts-no-device`. |
| TTS while the setup wizard/review is open | `tts-busy-setup` (it would corrupt the CABLE-A loopback check). |
| Input transcription rejected | `input-transcript-unsupported` notice; translation continues. |
| Rate limited | `rate-limited`; no automatic retry. |
| Several messages sent quickly | Spoken in submission order; Stop cancels all. |

None of these affects translation or passthrough audio. Assistant failures never call `health.reportFailure`.

## §14 Test strategy

vitest with injected fakes; no network, OpenAI or audio hardware.

| Area | Test file | Covers |
|---|---|---|
| Contracts | `assistantContract.test.ts` | defaults, invalid drop, guards, `isOpenAiHost` (https only, port), `selectLlmKey` never leaks (incl. `http://api.openai.com`) |
| IPC | `assistantHandlers.test.ts`, `ipcHandlersHook.test.ts` | every channel registered, trusted-sender check, `invalid-args`; `onPrefsChanged` fires after the 4 writes |
| Protocol (**M7**) | `appProtocol.test.ts` | path resolution, traversal and foreign-host rejection, headers, `isAppPageUrl` |
| Prefs / logger | extend existing | `setAssistant`, `setTranscriptWindow`, redaction (M7: `offscreenContract.test.ts` for `isSttResult`, `isSttWorkerStatusMsg`) |
| Transcript | `transcriptAssembler`, `transcriptStore`, `transcriptExport` | joining, idle finalize, waiting for lagging output (2.5 s lag across a 30 s boundary), late output attach, ring, `onFinal` once, `get`, `recent` |
| LLM | `llmClient`, `prompts`, `suggestionParser`, `sse`, `suggestionService` | body per host, header, both retries, `finish_reason` length, empty content, empty model, timeouts per host, model filter, debounce + `?` fast path, clearing rules |
| TTS | `pcmStreamChunker`, `ttsService`, `speakController` | chunking, request, check order, FIFO, done timing from first push, stopAll, idle close; ordering with two translations resolving in reverse, `cancelled` |
| STT | `openaiSttProtocol`, `openaiRealtimeStt`, `sttService`, `sttEntry` (M7: `localWhisperStt`) | session.update per model, events, ms-based commit, backoff reset on open, no-key instance, model in key, retry, failed-item finalize (M7: behind) |
| Translate | `openaiSession` (extend) | first frame unchanged with the option; second frame content; rejection latch and no resend on reconnect |
| Audio utils | `resampler` (M7: `utteranceSegmenter`, `whisperFilter`) | counts/no drift, 1 kHz passes, 14 kHz ≥ 20 dB down at 48k→24k (M7: 48k→16k, segmentation, hallucination filter) |
| Runtime | `assistantRuntime.test.ts` | syncAudio targets per state, translateTheirSpeech ordering before suggestions, cache invalidation, device change stops TTS, context push |
| Windows | `windowBounds.test.ts` | off-screen bounds clamped |
| Renderer | `transcriptState`, `useHashRoute` (extend), `assistantSummary` | reducer, `#/assistant` |
| i18n | existing parity test | new keys in 3 locales |

Manual QA (U12): `npm run build` is mandatory; an optional packaged smoke test (`npm run dist`, run `release/win-unpacked`) checks bar, passthrough, transcript window, OpenAI STT and typed speech. **Deferred to M7:** local Whisper first download, cache hit on relaunch, no jsdelivr request, `crossOriginIsolated === true`.

## §15 i18n

New groups `transcript`, `assistant`, plus `menu.transcript` and `review.section.assistant*`, in en-US, pt-BR (type source) and it-IT. Exact keys: plan U2. The parity test enforces identical keys and placeholders.

## §16 Acceptance criteria

1. With `sttEngine: 'openai'` and no translation, speech on both sides appears in the transcript within about 3 s of the speaker pausing. Passthrough audio shows no added latency or gaps.
2. While translating, both sides appear with the translation text, with no extra settings.
3. Typing "Can you hear me?" with source=it / target=en speaks English into the call in both modes; the entry shows original + translation and reaches `done`. Two messages sent quickly are spoken in order.
4. After the other person asks a question (ending in "?"), suggestions appear within about 5 s on `gpt-5-mini` while translating, and within about 6 s in passthrough with OpenAI STT. Speak plays one into the call.
5. Switching the LLM to Ollama with a pulled model works for features 2 and 3. Stopping Ollama gives the `llm-unreachable` message, and translation is unaffected.
6. **Deferred to M7:** in the **packaged** app, local Whisper downloads once, transcribes, and loads from cache on the next launch.
7. No transcript text, typed text or suggestion appears in `userData/logs/*.jsonl`.
8. `npm run typecheck`, `npm run lint`, `npx vitest run` and `npm run build` pass.

## §17 Risks

| Risk | Mitigation |
|---|---|
| GA transcription session shape differs (UNVERIFIED) | Isolated in `openaiSttProtocol.ts`; rejection logged with `param`. |
| Translate endpoint rejects input transcription | Second, separate update; rejection latched and reported; first update unchanged (§10.1). |
| Custom protocol / COOP-COEP breaks an existing page (**M7**) | Avoided in M6 by deferring the protocol. In M7: applied uniformly and verified in dev and packaged builds; COEP can fall back to `credentialless` in one place (`appProtocol.ts`). |
| WebGPU / WASM loading in a hidden window (**M7**) | Runtime probe, bundled WASM, packaged QA. |
| Local Whisper CPU load (**M7**) | Worker thread, threads only when isolated, per-stream cap, B priority, `behind` indicator. |
| Passthrough users without an OpenAI key get no transcript in M6 | Accepted until M7 (local Whisper); the CTA explains the key requirement. |
| TTS overlaps live translated audio on CABLE-A | Accepted for v1 (OS mixes). Possible follow-up: duck `A` while TTS plays. |
| Reasoning models return nothing | Generous budgets, `minimal` effort, `finish_reason` check. |
| Suggestions in the wrong language from small models | Languages stated explicitly; the user can edit before speaking. |
