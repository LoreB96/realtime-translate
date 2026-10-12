/**
 * Owns every call-assistant service (spec §4, plan U11a): transcript store/assembler, STT,
 * LLM + suggestions, TTS + typed speech. No Electron imports: app.ts (U11c) injects the
 * offscreen port, stores, broadcast, serialized() and the window operations.
 *
 * Never logs transcript, typed, prompt or suggestion text, or an LLM response.
 */
import { IPC } from '../../shared/events';
import {
  isOpenAiHost,
  MAX_TTS_INPUT_CHARS,
  resolveAssistantPrefs,
  selectLlmKey,
  type AssistantContext,
  type AssistantErrorCode,
  type AssistantPrefs,
  type AssistantPrefsPatch,
  type StoredAssistantPrefs,
  type TranscriptEntry,
} from '../../shared/assistant';
import type { T } from '../../shared/i18n';
import type { LanguageCode } from '../../shared/languages';
import type { PlaybackOptions } from '../../shared/offscreenContract';
import type { Direction } from '../../shared/types';
import type { AssistantHandlerDeps } from '../ipc/assistantHandlers';
import type { IpcSendMap, LlmModelsResult, LlmTestResult } from '../ipc/channels';
import { LlmClient, type CompleteOpts, type LlmUsage } from '../llm/llmClient';
import { LlmError, isAbortError } from '../llm/llmErrors';
import { TEST_MAX_TOKENS, translateWith } from '../llm/prompts';
import { SuggestionService } from '../llm/suggestionService';
import { createOpenAiSttFactory } from '../stt/openaiRealtimeStt';
import { sttSegmentToEntry } from '../stt/sttEntry';
import { SttService } from '../stt/sttService';
import type { SttTapController, SttTarget } from '../stt/sttTypes';
import { TranscriptAssembler } from '../transcript/transcriptAssembler';
import { formatTranscript } from '../transcript/transcriptExport';
import { TranscriptStore } from '../transcript/transcriptStore';
import type { WebSocketFactory } from '../translate/openaiSession';
import { SpeakController } from '../tts/speakController';
import { TtsService, type TtsPlaybackSink, type TtsStreamId } from '../tts/ttsService';
import type { FetchLike } from '../util/fetchLike';
import type { Logger } from '../util/logger';
import type { LlmPurpose } from '../../shared/usage';

/** Model the translate session uses for `audio.input.transcription` (spec §10.1). */
export const INPUT_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
/** Assembler idle-rule tick while translating (spec §6.1). */
export const TICK_MS = 500;
/** At most this many their-speech translations wait; the oldest is dropped. */
export const THEIR_SPEECH_MAX_PENDING = 3;
export const TEST_TIMEOUT_OPENAI_MS = 20000;
export const TEST_TIMEOUT_OTHER_MS = 120000;
/**
 * TtsService pushes PCM as fast as it downloads (faster than real time), so the backlog cap
 * must cover the longest allowed utterance: MAX_TTS_INPUT_CHARS at a conservative 10 chars/s
 * (TTS speaks ~14-16). A smaller cap would drop already-scheduled speech mid-utterance.
 */
export const TTS_MAX_BACKLOG_S = Math.ceil(MAX_TTS_INPUT_CHARS / 10);
const TTS_PLAYBACK: PlaybackOptions = { maxBacklogS: TTS_MAX_BACKLOG_S, catchup: false };
const TEST_MESSAGE = 'Reply with OK.';

export interface AssistantAudioState {
  translating: boolean;
  langs: { user: LanguageCode; them: LanguageCode };
  ttsDevices: { toMeet?: string; headset?: string };
  /** Passthrough streams running now that may be transcribed. */
  sttStreams: { direction: Direction; streamId: string }[];
  setupBusy: boolean;
}

/** M7 adds LocalSttBridge + reloadLocalModel. */
export interface AssistantOffscreenPort extends SttTapController {
  startPlaybackWithOptions(
    streamId: string,
    deviceId: string,
    opts: PlaybackOptions,
  ): Promise<void>;
  pushPlayback(streamId: string, b64: string): void;
  stopStream(streamId: string): void;
}

export interface SecretStore {
  getApiKey(): string | undefined;
  setApiKey(v: string): void;
  clearApiKey(): void;
}

export type AssistantBroadcast = <K extends keyof IpcSendMap>(
  channel: K,
  payload: IpcSendMap[K],
) => void;

/** Spend tracking (UsageMeter): counts only, never content. */
export interface AssistantUsageSink {
  addLlm(u: LlmUsage): void;
  addSttAudio(bytes: number, model: string): void;
  addTtsAudio(bytes: number, model: string): void;
}

/** Bytes of audio in a base64 string (no decoding). */
function b64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

export interface AssistantRuntimeDeps {
  fetch: FetchLike;
  wsFactory: WebSocketFactory;
  offscreen: AssistantOffscreenPort;
  loadStoredPrefs: () => StoredAssistantPrefs | undefined;
  saveAssistantPrefs: (patch: AssistantPrefsPatch) => AssistantPrefs;
  openAiKey: () => string | undefined;
  llmKeyStore: SecretStore;
  audioState: () => AssistantAudioState;
  serialized: <R>(fn: () => Promise<R>) => Promise<R>;
  broadcast: AssistantBroadcast;
  t: T;
  logger: Logger;
  usage?: AssistantUsageSink;
  now?: () => number;
  newId?: () => string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface AssistantWindowOps {
  openTranscriptView(): Promise<void>;
  openAssistantSettings(): Promise<void>;
  setTranscriptAlwaysOnTop(value: boolean): void;
  saveExport(format: 'txt' | 'md', text: string, sender: unknown): Promise<{ saved: boolean }>;
}

function errorCode(e: unknown): AssistantErrorCode {
  return e instanceof LlmError ? e.code : 'unknown';
}

export class AssistantRuntime {
  private readonly deps: AssistantRuntimeDeps;
  private readonly now: () => number;
  private readonly newId: () => string;
  private cachedPrefs: AssistantPrefs | undefined;
  private lastContextJson: string | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private inputRejectedReported = false;
  private disposed = false;

  private readonly store: TranscriptStore;
  private readonly assembler: TranscriptAssembler;
  private readonly llm: LlmClient;
  private readonly suggestions: SuggestionService;
  private readonly tts: TtsService;
  private readonly speak: SpeakController;
  private readonly stt: SttService;

  /** TTS streams opened on the offscreen page, by stream id. */
  private readonly ttsOpen = new Map<TtsStreamId, { deviceId: string; p: Promise<void> }>();

  /** Their-speech translation queue (serial). */
  private readonly theirQueue: TranscriptEntry[] = [];
  private theirRunning = false;
  private theirAbort: AbortController | undefined;

  constructor(deps: AssistantRuntimeDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    let seq = 0;
    this.newId =
      deps.newId ??
      ((): string => {
        seq += 1;
        return `${this.now().toString(36)}-${seq}`;
      });
    const setTimer = deps.setTimer ?? setTimeout;
    const clearTimer = deps.clearTimer ?? clearTimeout;
    const { logger } = deps;

    this.store = new TranscriptStore({
      now: this.now,
      onUpsert: (e) => deps.broadcast(IPC.TranscriptEntry, e),
      onCleared: () => deps.broadcast(IPC.TranscriptCleared, undefined),
      onFinal: (e) => this.handleFinal(e),
    });
    this.assembler = new TranscriptAssembler({
      now: this.now,
      langs: () => deps.audioState().langs,
    });

    this.llm = new LlmClient({
      fetch: deps.fetch,
      logger,
      now: this.now,
      setTimer,
      clearTimer,
      ...(deps.usage ? { onUsage: (u: LlmUsage) => deps.usage?.addLlm(u) } : {}),
      config: () => {
        const l = this.prefs().llm;
        const k = selectLlmKey(l.baseUrl, deps.openAiKey(), deps.llmKeyStore.getApiKey());
        return {
          baseUrl: l.baseUrl,
          model: l.model,
          reasoningEffort: l.reasoningEffort,
          ...(k ? { apiKey: k } : {}),
        };
      },
    });

    this.suggestions = new SuggestionService({
      llm: this.llmFor('suggest'),
      recent: () => this.store.recent({ maxEntries: 30, maxChars: 6000, finalOnly: true }),
      langs: () => deps.audioState().langs,
      enabled: () => {
        const p = this.prefs();
        return { suggestions: p.suggestionsEnabled, auto: p.autoSuggest };
      },
      onState: (s) => deps.broadcast(IPC.SuggestionsChanged, s),
      now: this.now,
      setTimer,
      clearTimer,
      logger,
    });

    this.tts = new TtsService({
      fetch: deps.fetch,
      apiKey: deps.openAiKey,
      devices: () => deps.audioState().ttsDevices,
      prefs: () => {
        const p = this.prefs();
        return { voice: p.ttsVoice, model: p.ttsModel, monitor: p.ttsMonitor };
      },
      busy: () => deps.audioState().setupBusy,
      sink: this.makeTtsSink(),
      now: this.now,
      setTimer,
      clearTimer,
      logger,
    });

    this.speak = new SpeakController({
      store: this.store,
      translate: (text, from, to, signal) =>
        translateWith(this.llmFor('speak'), text, from, to, signal),
      tts: this.tts,
      langs: () => deps.audioState().langs,
      onError: (code) => deps.broadcast(IPC.AssistantError, { scope: 'speak', code }),
      now: this.now,
      newId: this.newId,
      logger,
    });

    this.stt = new SttService({
      engines: {
        openai: createOpenAiSttFactory({
          apiKey: deps.openAiKey,
          model: () => this.prefs().sttOpenAiModel,
          wsFactory: deps.wsFactory,
          setTimer,
          clearTimer,
          logger,
        }),
      },
      tap: {
        // Counts the audio sent to the transcription service (billed per audio minute).
        setTap: (streamId, mode, opts, onPcm) =>
          deps.offscreen.setTap(
            streamId,
            mode,
            opts,
            onPcm && deps.usage
              ? (b64: string): void => {
                  deps.usage?.addSttAudio(b64Bytes(b64), this.prefs().sttOpenAiModel);
                  onPcm(b64);
                }
              : onPcm,
          ),
      },
      models: () => ({ openai: this.prefs().sttOpenAiModel }),
      onSegment: (s) => {
        const e = sttSegmentToEntry(
          this.store.get(`stt-${s.id}`),
          s,
          deps.audioState().langs,
          this.now(),
        );
        if (e) this.store.upsert(e);
      },
      onStatus: (s) => deps.broadcast(IPC.SttStatusChanged, s),
      now: this.now,
      setTimer,
      clearTimer,
      logger,
    });
  }

  // ---------------------------------------------------------------------------
  // Prefs and context
  // ---------------------------------------------------------------------------

  prefs(): AssistantPrefs {
    if (!this.cachedPrefs) this.cachedPrefs = resolveAssistantPrefs(this.deps.loadStoredPrefs());
    return this.cachedPrefs;
  }

  context(): AssistantContext {
    const st = this.deps.audioState();
    return {
      langs: { user: st.langs.user, them: st.langs.them },
      translating: st.translating,
      hasOpenAiKey: !!this.deps.openAiKey(),
      hasToMeetDevice: !!st.ttsDevices.toMeet,
      setupBusy: st.setupBusy,
    };
  }

  inputTranscriptionModel(): string | undefined {
    return this.prefs().translateInputTranscript ? INPUT_TRANSCRIPTION_MODEL : undefined;
  }

  // ---------------------------------------------------------------------------
  // Translate session hooks
  // ---------------------------------------------------------------------------

  onTranslateStart(): void {
    this.stopTick();
    if (!this.disposed) {
      const setIntervalFn = this.deps.setIntervalFn ?? setInterval;
      this.tick = setIntervalFn(() => {
        for (const e of this.assembler.tick()) this.store.upsert(e);
      }, TICK_MS);
    }
    this.pushContext();
  }

  onTranslateStop(): void {
    for (const e of this.assembler.finalizeAll()) this.store.upsert(e);
    this.stopTick();
    // The next Start may report a rejected input transcription again.
    this.inputRejectedReported = false;
    this.pushContext();
  }

  onTranslateDelta(d: { direction: Direction; kind: 'input' | 'output'; text: string }): void {
    const e = this.assembler.onTranslateDelta(d);
    if (e) this.store.upsert(e);
  }

  onInputTranscriptionRejected(direction: Direction): void {
    if (this.inputRejectedReported) return;
    this.inputRejectedReported = true;
    this.deps.logger.warn('assistant_input_transcript_unsupported', { direction });
    this.deps.broadcast(IPC.AssistantError, {
      scope: 'stt',
      code: 'input-transcript-unsupported',
    });
  }

  // ---------------------------------------------------------------------------
  // Audio convergence and app hooks
  // ---------------------------------------------------------------------------

  /** Converges STT to audioState(). Caller MUST run it inside serialized(); never calls it. */
  async syncAudio(): Promise<void> {
    if (this.disposed) return;
    const st = this.deps.audioState();
    const engine = this.prefs().sttEngine;
    const targets: SttTarget[] = st.setupBusy
      ? []
      : st.sttStreams.map(({ direction, streamId }) => ({
          streamId,
          direction,
          lang: direction === 'A' ? st.langs.user : st.langs.them,
        }));
    await this.stt.sync(engine, targets);
    this.pushContext();
  }

  async onPrefsChanged(what: 'languages' | 'devices' | 'apiKey'): Promise<void> {
    this.cachedPrefs = undefined;
    if (what === 'devices') this.tts.stopAll();
    this.pushContext();
    await this.deps.serialized(async () => {
      await this.syncAudio();
      // The STT diff key has no API key in it: restart the running engines so a new key is
      // used (and a `no-openai-key` error clears) right away (spec: "Adding the key re-syncs STT immediately").
      if (what === 'apiKey' && !this.disposed) await this.stt.retry();
    });
  }

  onDeviceChange(): void {
    this.tts.stopAll();
  }

  onTtsStreamEvent(): void {
    this.tts.stopAll();
  }

  onSetupViewChanged(): void {
    // The wizard/review run loopback checks on CABLE-A: speech already playing (or still
    // being translated/queued) must stop, not only new speech be refused (spec §6.5).
    if (this.deps.audioState().setupBusy) this.speak.stop();
    this.pushContext();
  }

  /**
   * Stops STT and every typed-speech item, including one still in its translate step (only
   * SpeakController.stop() aborts that). The caller reports `setupBusy` from audioState()
   * for the duration of the run, so speech sent meanwhile is refused with tts-busy-setup.
   */
  async stopForDiagnostics(): Promise<void> {
    this.speak.stop();
    await this.stt.stopAll();
    this.pushContext();
  }

  // ---------------------------------------------------------------------------
  // IPC
  // ---------------------------------------------------------------------------

  handlerDeps(
    win: AssistantWindowOps,
  ): Omit<AssistantHandlerDeps, 'isTrustedSender' | 'getUsage' | 'resetUsage'> {
    return {
      openTranscriptView: () => win.openTranscriptView(),
      openAssistantSettings: () => win.openAssistantSettings(),
      setTranscriptAlwaysOnTop: (value) => win.setTranscriptAlwaysOnTop(value),
      getTranscript: () => this.store.snapshot(),
      clearTranscript: () => {
        this.assembler.reset();
        this.store.clear();
      },
      exportTranscript: (format, sender: unknown) =>
        win.saveExport(
          format,
          formatTranscript(this.store.snapshot(), {
            format,
            t: this.deps.t,
            date: new Date(this.now()),
          }),
          sender,
        ),
      setAssistantPrefs: async (patch) => {
        const p = this.deps.saveAssistantPrefs(patch);
        this.cachedPrefs = undefined;
        this.deps.broadcast(IPC.AssistantPrefsChanged, p);
        if (!p.suggestionsEnabled) this.suggestions.cancel();
        await this.deps.serialized(() => this.syncAudio());
        return p;
      },
      getLlmKeyHint: () => {
        const k = this.deps.llmKeyStore.getApiKey();
        return k !== undefined && k.length > 4 ? k.slice(-4) : undefined;
      },
      setLlmKey: (value) => this.deps.llmKeyStore.setApiKey(value),
      clearLlmKey: () => this.deps.llmKeyStore.clearApiKey(),
      testLlm: () => this.testLlm(),
      listLlmModels: () => this.listLlmModels(),
      speakText: (a) => this.speak.speak(a),
      stopSpeaking: () => this.speak.stop(),
      suggestNow: () => this.suggestions.requestNow(),
      getSuggestions: () => this.suggestions.state(),
      getSttStatus: () => this.stt.status(),
      retryStt: () => this.deps.serialized(() => this.stt.retry()),
      getAssistantContext: () => this.context(),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.speak.stop();
    this.suggestions.cancel();
    this.theirQueue.length = 0;
    this.theirAbort?.abort();
    this.stopTick();
    await this.stt.stopAll();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async testLlm(): Promise<LlmTestResult> {
    const timeoutMs = isOpenAiHost(this.prefs().llm.baseUrl)
      ? TEST_TIMEOUT_OPENAI_MS
      : TEST_TIMEOUT_OTHER_MS;
    const started = this.now();
    try {
      const text = await this.llm.complete({
        messages: [{ role: 'user', content: TEST_MESSAGE }],
        maxTokens: TEST_MAX_TOKENS,
        timeoutMs,
      });
      if (text.trim() === '') {
        this.deps.logger.warn('llm_test_failed', { code: 'llm-bad-response' });
        return { ok: false, code: 'llm-bad-response' };
      }
      const ms = this.now() - started;
      this.deps.logger.info('llm_test_ok', { ms });
      return { ok: true, ms };
    } catch (e) {
      const code = errorCode(e);
      this.deps.logger.warn('llm_test_failed', { code });
      return { ok: false, code };
    }
  }

  private async listLlmModels(): Promise<LlmModelsResult> {
    try {
      const models = await this.llm.listModels();
      return { ok: true, models };
    } catch (e) {
      const code = errorCode(e);
      this.deps.logger.warn('llm_list_models_failed', { code });
      return { ok: false, code };
    }
  }

  /** The LLM client with every call tagged for spend tracking. */
  private llmFor(purpose: LlmPurpose): Pick<LlmClient, 'complete'> {
    return { complete: (o: CompleteOpts) => this.llm.complete({ ...o, purpose }) };
  }

  private pushContext(): void {
    const ctx = this.context();
    const json = JSON.stringify(ctx);
    if (json === this.lastContextJson) return;
    this.lastContextJson = json;
    this.deps.broadcast(IPC.AssistantContextChanged, ctx);
  }

  private stopTick(): void {
    if (this.tick === undefined) return;
    (this.deps.clearIntervalFn ?? clearInterval)(this.tick);
    this.tick = undefined;
  }

  private makeTtsSink(): TtsPlaybackSink {
    const { offscreen } = this.deps;
    return {
      open: (id, deviceId) => {
        const memo = this.ttsOpen.get(id);
        if (memo && memo.deviceId === deviceId) return memo.p;
        if (memo) {
          this.ttsOpen.delete(id);
          offscreen.stopStream(id);
        }
        const rec: { deviceId: string; p: Promise<void> } = {
          deviceId,
          p: Promise.resolve(),
        };
        rec.p = offscreen
          .startPlaybackWithOptions(id, deviceId, TTS_PLAYBACK)
          .catch((e: unknown) => {
            if (this.ttsOpen.get(id) === rec) this.ttsOpen.delete(id);
            throw e;
          });
        this.ttsOpen.set(id, rec);
        return rec.p;
      },
      push: (id, b64) => {
        // The headset monitor replays the same audio: bill the call stream only.
        if (id === 'tts') this.deps.usage?.addTtsAudio(b64Bytes(b64), this.prefs().ttsModel);
        offscreen.pushPlayback(id, b64);
      },
      close: (id) => {
        this.ttsOpen.delete(id);
        offscreen.stopStream(id);
      },
    };
  }

  /** onFinal from the store: their-speech translation (opt-in) before suggestions. */
  private handleFinal(e: TranscriptEntry): void {
    const langs = this.deps.audioState().langs;
    if (
      e.speaker === 'them' &&
      e.source === 'stt' &&
      !e.translated &&
      this.prefs().translateTheirSpeech &&
      langs.user !== langs.them
    ) {
      this.theirQueue.push(e);
      while (this.theirQueue.length > THEIR_SPEECH_MAX_PENDING) {
        this.theirQueue.shift();
        this.deps.logger.info('their_speech_dropped', {});
      }
      void this.pumpTheirSpeech();
      return;
    }
    this.suggestions.onFinalEntry(e);
  }

  private async pumpTheirSpeech(): Promise<void> {
    if (this.theirRunning) return;
    this.theirRunning = true;
    try {
      for (let e = this.theirQueue.shift(); e; e = this.theirQueue.shift()) {
        if (this.disposed) return;
        const ac = new AbortController();
        this.theirAbort = ac;
        const { user, them } = this.deps.audioState().langs;
        try {
          const translated = await translateWith(
            this.llmFor('their'),
            e.original,
            them,
            user,
            ac.signal,
          );
          if (ac.signal.aborted || this.disposed) return;
          this.store.patch(e.id, { translated, translatedLang: user });
        } catch (err) {
          if (ac.signal.aborted || this.disposed || isAbortError(err)) return;
          this.deps.logger.warn('their_speech_translate_failed', { code: errorCode(err) });
        } finally {
          if (this.theirAbort === ac) this.theirAbort = undefined;
        }
        this.suggestions.onFinalEntry(this.store.get(e.id) ?? e);
      }
    } finally {
      this.theirRunning = false;
    }
  }
}
