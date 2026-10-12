import { describe, it, expect, vi } from 'vitest';
import {
  AssistantRuntime,
  INPUT_TRANSCRIPTION_MODEL,
  TTS_MAX_BACKLOG_S,
  type AssistantAudioState,
  type AssistantOffscreenPort,
  type AssistantRuntimeDeps,
  type AssistantWindowOps,
} from '@main/assistant/assistantRuntime';
import type { FetchLike, FetchResponseLike } from '@main/util/fetchLike';
import type { WebSocketLike } from '@main/translate/openaiSession';
import type { Logger } from '@main/util/logger';
import {
  LLM_PRESETS,
  MAX_TTS_INPUT_CHARS,
  mergeAssistantPrefs,
  resolveAssistantPrefs,
  type AssistantContext,
  type StoredAssistantPrefs,
  type TranscriptEntry,
} from '@shared/assistant';
import { IPC } from '@shared/events';
import type { PlaybackOptions, TapMode, TapOptions } from '@shared/offscreenContract';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function jsonResponse(json: unknown, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(JSON.stringify(json)),
  };
}

function chatResponse(content: string): FetchResponseLike {
  return jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] });
}

function pcmResponse(bytes: number): FetchResponseLike {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    body,
  };
}

interface FakeWs extends WebSocketLike {
  url: string;
  emit(json: unknown): void;
}

interface SetupOpts {
  stored?: StoredAssistantPrefs;
  key?: string;
  audio?: Partial<AssistantAudioState>;
  /** Chat responder: `kind` is 'suggest' when the body asks for reply suggestions. */
  chat?: (
    kind: 'translate' | 'suggest' | 'other',
    body: string,
  ) => FetchResponseLike | Promise<FetchResponseLike>;
}

function setup(opts: SetupOpts = {}) {
  const log: string[] = [];
  const fetchCalls: FetchCall[] = [];
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const taps: Array<{ streamId: string; mode: TapMode; opts: TapOptions | undefined }> = [];
  const playback: Array<{ op: string; streamId: string; deviceId?: string }> = [];
  const playbackOpts: PlaybackOptions[] = [];
  const sockets: FakeWs[] = [];
  const intervals: Array<() => void> = [];
  let clearedIntervals = 0;
  let stored: StoredAssistantPrefs | undefined = opts.stored;
  let key: string | undefined = opts.key;
  let llmKey: string | undefined;
  let clock = 1_000_000;

  const audio: AssistantAudioState = {
    translating: false,
    langs: { user: 'pt', them: 'en' },
    ttsDevices: {},
    sttStreams: [],
    setupBusy: false,
    ...opts.audio,
  };

  const chat =
    opts.chat ??
    ((kind) =>
      kind === 'suggest'
        ? chatResponse('{"suggestions":[{"text":"Claro","translation":"Sure"}]}')
        : chatResponse('Tudo bem com você?'));

  const fetch: FetchLike = (url, init) => {
    const body = init.body ?? '';
    fetchCalls.push({ url, headers: init.headers, body });
    if (url.endsWith('/audio/speech')) {
      log.push('fetch:tts');
      return Promise.resolve(pcmResponse(4800));
    }
    if (url.endsWith('/models')) {
      return Promise.resolve(jsonResponse({ data: [{ id: 'b' }, { id: 'a' }] }));
    }
    const kind = body.includes('reply_suggestions')
      ? 'suggest'
      : body.includes('You translate')
        ? 'translate'
        : 'other';
    log.push(`fetch:${kind}`);
    return Promise.resolve(chat(kind, body));
  };

  const wsFactory = (url: string): WebSocketLike => {
    const ws: FakeWs = {
      url,
      readyState: 0,
      send: () => undefined,
      close: () => undefined,
      emit(json: unknown) {
        ws.onmessage?.(JSON.stringify(json));
      },
    };
    sockets.push(ws);
    return ws;
  };

  const offscreen: AssistantOffscreenPort = {
    setTap: (streamId, mode, o) => {
      taps.push({ streamId, mode, opts: o });
      return Promise.resolve();
    },
    startPlaybackWithOptions: (streamId, deviceId, o) => {
      playback.push({ op: 'start', streamId, deviceId });
      playbackOpts.push(o);
      return Promise.resolve();
    },
    pushPlayback: () => undefined,
    stopStream: (streamId) => {
      playback.push({ op: 'stop', streamId });
    },
  };

  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  let serializedCalls = 0;
  const serialized = <R>(fn: () => Promise<R>): Promise<R> => {
    serializedCalls += 1;
    return fn();
  };

  const deps: AssistantRuntimeDeps = {
    fetch,
    wsFactory,
    offscreen,
    loadStoredPrefs: () => stored,
    saveAssistantPrefs: (patch) => {
      stored = mergeAssistantPrefs(stored, patch);
      return resolveAssistantPrefs(stored);
    },
    openAiKey: () => key,
    llmKeyStore: {
      getApiKey: () => llmKey,
      setApiKey: (v) => {
        llmKey = v;
      },
      clearApiKey: () => {
        llmKey = undefined;
      },
    },
    audioState: () => audio,
    serialized,
    broadcast: (channel, payload) => {
      broadcasts.push({ channel, payload });
      if (channel === IPC.TranscriptEntry) {
        const e = payload as TranscriptEntry;
        if (e.translated !== '') log.push(`entry-translated:${e.id}`);
      }
    },
    t: (k) => k,
    logger,
    now: () => clock,
    setIntervalFn: ((cb: () => void) => {
      intervals.push(cb);
      return intervals.length as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => {
      clearedIntervals += 1;
    }) as unknown as typeof clearInterval,
  };

  const rt = new AssistantRuntime(deps);
  const win: AssistantWindowOps = {
    openTranscriptView: () => Promise.resolve(),
    openAssistantSettings: () => Promise.resolve(),
    setTranscriptAlwaysOnTop: () => undefined,
    saveExport: vi.fn(() => Promise.resolve({ saved: true })),
  };
  const h = rt.handlerDeps(win);

  return {
    rt,
    h,
    win,
    audio,
    log,
    fetchCalls,
    broadcasts,
    taps,
    playback,
    playbackOpts,
    sockets,
    intervals,
    logger,
    serializedCalls: () => serializedCalls,
    setKey: (k: string | undefined) => {
      key = k;
    },
    setLlmKey: (k: string | undefined) => {
      llmKey = k;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    clearedIntervals: () => clearedIntervals,
    of: <P>(channel: string): P[] =>
      broadcasts.filter((b) => b.channel === channel).map((b) => b.payload as P),
  };
}

const tapsOn = (taps: Array<{ streamId: string; mode: TapMode; opts: TapOptions | undefined }>) =>
  taps.filter((t) => t.mode !== 'off').map((t) => `${t.streamId}:${t.opts?.lang ?? ''}`);
const tapsOff = (taps: Array<{ streamId: string; mode: TapMode }>) =>
  taps.filter((t) => t.mode === 'off').map((t) => t.streamId);

const PASS_BOTH = [
  { direction: 'A' as const, streamId: 'pass-A' },
  { direction: 'B' as const, streamId: 'pass-B' },
];

// ---------------------------------------------------------------------------
// syncAudio
// ---------------------------------------------------------------------------

describe('AssistantRuntime.syncAudio', () => {
  it('taps both passthrough streams with the matching languages', async () => {
    const s = setup({
      stored: { sttEngine: 'openai' },
      key: 'sk-test',
      audio: { sttStreams: PASS_BOTH },
    });
    await s.rt.syncAudio();
    expect(tapsOn(s.taps)).toEqual(['pass-A:pt', 'pass-B:en']);
    expect(s.taps.every((t) => t.mode === 'off' || t.mode === 'main24k')).toBe(true);
    expect(s.sockets).toHaveLength(2);
    expect(s.serializedCalls()).toBe(0);
  });

  it('does nothing while sttEngine is off', async () => {
    const s = setup({ key: 'sk-test', audio: { sttStreams: PASS_BOTH } });
    await s.rt.syncAudio();
    expect(s.taps).toEqual([]);
  });

  it('translating with no failed directions → no STT (streams stopped)', async () => {
    const s = setup({
      stored: { sttEngine: 'openai' },
      key: 'sk-test',
      audio: { sttStreams: PASS_BOTH },
    });
    await s.rt.syncAudio();
    s.audio.translating = true;
    s.audio.sttStreams = [];
    await s.rt.syncAudio();
    expect(tapsOff(s.taps)).toEqual(['pass-A', 'pass-B']);
    expect(s.h.getSttStatus().state).toBe('off');
  });

  it('parked A → only B is transcribed', async () => {
    const s = setup({
      stored: { sttEngine: 'openai' },
      key: 'sk-test',
      audio: { sttStreams: [{ direction: 'B', streamId: 'pass-B' }] },
    });
    await s.rt.syncAudio();
    expect(tapsOn(s.taps)).toEqual(['pass-B:en']);
    expect(s.h.getSttStatus().streams).toEqual(['B']);
  });

  it('setupBusy → nothing is transcribed', async () => {
    const s = setup({
      stored: { sttEngine: 'openai' },
      key: 'sk-test',
      audio: { sttStreams: PASS_BOTH, setupBusy: true },
    });
    await s.rt.syncAudio();
    expect(s.taps).toEqual([]);
  });

  it('a language change restarts only the affected stream', async () => {
    const s = setup({
      stored: { sttEngine: 'openai' },
      key: 'sk-test',
      audio: { sttStreams: PASS_BOTH },
    });
    await s.rt.syncAudio();
    s.taps.length = 0;
    s.audio.langs = { user: 'pt', them: 'es' };
    await s.rt.onPrefsChanged('languages');
    expect(tapsOff(s.taps)).toEqual(['pass-B']);
    expect(tapsOn(s.taps)).toEqual(['pass-B:es']);
  });

  it('a model change (setAssistantPrefs) restarts both streams with the new model', async () => {
    const s = setup({
      stored: { sttEngine: 'openai' },
      key: 'sk-test',
      audio: { sttStreams: PASS_BOTH },
    });
    await s.rt.syncAudio();
    s.taps.length = 0;
    await s.h.setAssistantPrefs({ sttOpenAiModel: 'gpt-4o-transcribe' });
    expect(tapsOff(s.taps)).toEqual(['pass-A', 'pass-B']);
    expect(s.taps.filter((t) => t.mode === 'main24k').map((t) => t.opts?.model)).toEqual([
      'gpt-4o-transcribe',
      'gpt-4o-transcribe',
    ]);
    expect(s.serializedCalls()).toBe(1);
  });

  it('pushes AssistantContextChanged only when the context changed', async () => {
    const s = setup();
    await s.rt.syncAudio();
    await s.rt.syncAudio();
    expect(s.of<AssistantContext>(IPC.AssistantContextChanged)).toHaveLength(1);
    s.audio.setupBusy = true;
    s.rt.onSetupViewChanged();
    const ctx = s.of<AssistantContext>(IPC.AssistantContextChanged);
    expect(ctx).toHaveLength(2);
    expect(ctx[1]?.setupBusy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// onPrefsChanged / device hooks / TTS memo
// ---------------------------------------------------------------------------

describe('AssistantRuntime prefs and device hooks', () => {
  it("onPrefsChanged('apiKey') re-syncs STT inside serialized and pushes context", async () => {
    const s = setup({ stored: { sttEngine: 'openai' }, audio: { sttStreams: [PASS_BOTH[1]!] } });
    await s.rt.syncAudio();
    expect(s.h.getSttStatus().errorCode).toBe('no-openai-key');
    expect(s.sockets).toHaveLength(0);
    expect(s.rt.context().hasOpenAiKey).toBe(false);

    s.setKey('sk-new');
    await s.rt.onPrefsChanged('apiKey');
    expect(s.serializedCalls()).toBe(1);
    const ctx = s.of<AssistantContext>(IPC.AssistantContextChanged);
    expect(ctx[ctx.length - 1]?.hasOpenAiKey).toBe(true);
    expect(s.sockets).toHaveLength(1);
    expect(s.h.getSttStatus().state).toBe('listening');
  });

  it("onPrefsChanged('devices') stops the open TTS stream", async () => {
    const s = setup({ key: 'sk-test', audio: { ttsDevices: { toMeet: 'meet-1' } } });
    s.h.speakText({ text: 'Bom dia a todos', translate: false });
    await vi.waitFor(() =>
      expect(s.playback).toContainEqual({ op: 'start', streamId: 'tts', deviceId: 'meet-1' }),
    );
    await s.rt.onPrefsChanged('devices');
    expect(s.playback).toContainEqual({ op: 'stop', streamId: 'tts' });
  });

  it('onDeviceChange closes the memoised TTS stream so the next speak re-opens it', async () => {
    const s = setup({ key: 'sk-test', audio: { ttsDevices: { toMeet: 'meet-1' } } });
    const starts = () => s.playback.filter((p) => p.op === 'start').length;
    const done = (id: string) =>
      s.of<TranscriptEntry>(IPC.TranscriptEntry).some((e) => e.id === id && e.speak === 'done');

    const first = s.h.speakText({ text: 'Primeira frase', translate: false });
    await vi.waitFor(() => expect(done(first.entryId)).toBe(true), { timeout: 3000 });
    const second = s.h.speakText({ text: 'Segunda frase', translate: false });
    await vi.waitFor(() => expect(done(second.entryId)).toBe(true), { timeout: 3000 });
    expect(starts()).toBe(1); // memoised: same device, no re-open

    const before = s.playback.length;
    s.rt.onDeviceChange();
    expect(s.playback.slice(before)).toContainEqual({ op: 'stop', streamId: 'tts' });
    const third = s.h.speakText({ text: 'Terceira frase', translate: false });
    await vi.waitFor(() => expect(done(third.entryId)).toBe(true), { timeout: 3000 });
    expect(starts()).toBe(2);
  });

  it('opens TTS with a backlog cap that fits the longest allowed utterance', async () => {
    const s = setup({ key: 'sk-test', audio: { ttsDevices: { toMeet: 'meet-1' } } });
    s.h.speakText({ text: 'Bom dia', translate: false });
    await vi.waitFor(() => expect(s.playbackOpts).toHaveLength(1));
    expect(s.playbackOpts[0]).toEqual({ maxBacklogS: TTS_MAX_BACKLOG_S, catchup: false });
    // ≥ the playout of MAX_TTS_INPUT_CHARS at 10 chars/s (TTS speaks faster).
    expect(TTS_MAX_BACKLOG_S).toBeGreaterThanOrEqual(MAX_TTS_INPUT_CHARS / 10);
  });

  it('opening setup (setupBusy) stops speech already playing and cancels queued items', async () => {
    const s = setup({ key: 'sk-test', audio: { ttsDevices: { toMeet: 'meet-1' } } });
    const first = s.h.speakText({ text: 'Primeira frase longa', translate: false });
    const second = s.h.speakText({ text: 'Segunda frase', translate: false });
    await vi.waitFor(() =>
      expect(s.playback).toContainEqual({ op: 'start', streamId: 'tts', deviceId: 'meet-1' }),
    );
    // Non-device setup routes (troubleshoot / assistant) leave speech alone.
    const before = s.playback.length;
    s.rt.onSetupViewChanged();
    expect(s.playback.slice(before)).toEqual([]);

    s.audio.setupBusy = true;
    s.rt.onSetupViewChanged();
    expect(s.playback.slice(before)).toContainEqual({ op: 'stop', streamId: 'tts' });
    const entries = s.of<TranscriptEntry>(IPC.TranscriptEntry);
    const last = (id: string) => entries.filter((e) => e.id === id).at(-1);
    expect(last(second.entryId)?.speak).toBe('cancelled');
    expect(last(first.entryId)?.speak).not.toBe('done');
  });

  it('stopForDiagnostics aborts an item still in its translate step: nothing reaches TTS', async () => {
    let release: (() => void) | undefined;
    const s = setup({
      key: 'sk-test',
      audio: { ttsDevices: { toMeet: 'meet-1' } },
      chat: (kind) =>
        kind === 'translate'
          ? new Promise<FetchResponseLike>((resolve) => {
              release = () => resolve(chatResponse('Good morning'));
            })
          : chatResponse('ok'),
    });
    const r = s.h.speakText({ text: 'Bom dia', translate: true });
    await vi.waitFor(() => expect(release).toBeDefined());
    await s.rt.stopForDiagnostics();
    release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.log).not.toContain('fetch:tts');
    expect(s.playback.filter((p) => p.op === 'start')).toEqual([]);
    const entries = s.of<TranscriptEntry>(IPC.TranscriptEntry).filter((e) => e.id === r.entryId);
    expect(entries.at(-1)?.speak).toBe('cancelled');
  });

  it('clearTranscript also resets the assembler: a late delta does not resurrect the entry', () => {
    const s = setup({ audio: { translating: true } });
    s.rt.onTranslateStart();
    s.rt.onTranslateDelta({ direction: 'B', kind: 'input', text: 'How are you' });
    s.advance(5000);
    s.intervals[0]!(); // finalized with no translation yet
    const cleared = s.h.getTranscript()[0]!;
    s.h.clearTranscript();
    s.advance(100);
    s.rt.onTranslateDelta({ direction: 'B', kind: 'output', text: 'Tudo bem' });
    const now = s.h.getTranscript();
    expect(now).toHaveLength(1);
    expect(now[0]?.id).not.toBe(cleared.id);
    expect(now[0]).toMatchObject({ final: false, original: '' });
  });

  it('setAssistantPrefs invalidates the cache and broadcasts the new prefs', async () => {
    const s = setup();
    expect(s.rt.prefs().ttsVoice).toBe('cedar');
    const p = await s.h.setAssistantPrefs({ ttsVoice: 'nova' });
    expect(p.ttsVoice).toBe('nova');
    expect(s.rt.prefs().ttsVoice).toBe('nova');
    expect(s.of(IPC.AssistantPrefsChanged)).toEqual([p]);
  });

  it('inputTranscriptionModel follows translateInputTranscript', async () => {
    const s = setup();
    expect(s.rt.inputTranscriptionModel()).toBe(INPUT_TRANSCRIPTION_MODEL);
    await s.h.setAssistantPrefs({ translateInputTranscript: false });
    expect(s.rt.inputTranscriptionModel()).toBeUndefined();
    await s.h.setAssistantPrefs({ translateInputTranscript: true });
    expect(s.rt.inputTranscriptionModel()).toBe(INPUT_TRANSCRIPTION_MODEL);
  });
});

// ---------------------------------------------------------------------------
// Translate deltas
// ---------------------------------------------------------------------------

describe('AssistantRuntime translate deltas', () => {
  it('broadcasts TranscriptEntry updates and finalizes on stop', () => {
    const s = setup({ audio: { translating: true } });
    s.rt.onTranslateStart();
    expect(s.intervals).toHaveLength(1);
    s.rt.onTranslateDelta({ direction: 'A', kind: 'input', text: 'Olá' });
    s.rt.onTranslateDelta({ direction: 'A', kind: 'output', text: 'Hello' });
    const before = s.of<TranscriptEntry>(IPC.TranscriptEntry);
    expect(before).toHaveLength(2);
    expect(before[1]).toMatchObject({
      speaker: 'me',
      original: 'Olá',
      translated: 'Hello',
      final: false,
    });

    s.rt.onTranslateStop();
    const after = s.of<TranscriptEntry>(IPC.TranscriptEntry);
    expect(after[after.length - 1]).toMatchObject({ final: true, original: 'Olá' });
    expect(s.clearedIntervals()).toBe(1);
    expect(s.h.getTranscript()).toHaveLength(1);
  });

  it('the tick finalizes an idle entry', () => {
    const s = setup({ audio: { translating: true } });
    s.rt.onTranslateStart();
    s.rt.onTranslateDelta({ direction: 'B', kind: 'input', text: 'Hi there' });
    s.rt.onTranslateDelta({ direction: 'B', kind: 'output', text: 'Olá' });
    s.advance(5000);
    s.intervals[0]!();
    expect(s.h.getTranscript()[0]).toMatchObject({ speaker: 'them', final: true });
  });

  it('reports a rejected input transcription once per Start', () => {
    const s = setup();
    s.rt.onTranslateStart();
    s.rt.onInputTranscriptionRejected('A');
    s.rt.onInputTranscriptionRejected('B');
    expect(s.of(IPC.AssistantError)).toEqual([
      { scope: 'stt', code: 'input-transcript-unsupported' },
    ]);
    s.rt.onTranslateStop();
    s.rt.onTranslateStart();
    s.rt.onInputTranscriptionRejected('A');
    expect(s.of(IPC.AssistantError)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Their-speech translation before suggestions
// ---------------------------------------------------------------------------

async function runTheirSpeech(opts: SetupOpts) {
  const s = setup({
    key: 'sk-test',
    audio: { sttStreams: [{ direction: 'B', streamId: 'pass-B' }] },
    ...opts,
  });
  await s.rt.syncAudio();
  const ws = s.sockets[0]!;
  ws.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item1',
    transcript: 'How are you doing today?',
  });
  await vi.advanceTimersByTimeAsync(2000);
  return s;
}

describe('AssistantRuntime translateTheirSpeech', () => {
  it('patches the translation into the entry before suggestions run', async () => {
    vi.useFakeTimers();
    try {
      const s = await runTheirSpeech({
        stored: { sttEngine: 'openai', translateTheirSpeech: true },
      });
      const order = s.log.filter((l) => l !== 'fetch:tts');
      expect(order[0]).toBe('fetch:translate');
      expect(order[1]).toMatch(/^entry-translated:stt-/);
      expect(order[2]).toBe('fetch:suggest');
      const entry = s.h.getTranscript()[0]!;
      expect(entry).toMatchObject({
        speaker: 'them',
        translated: 'Tudo bem com você?',
        translatedLang: 'pt',
      });
      const suggestBody = s.fetchCalls.find((c) => c.body.includes('reply_suggestions'))!.body;
      expect(suggestBody).toContain('Tudo bem com você?');
      expect(s.h.getSuggestions().status).toBe('ready');
      // Privacy: no transcript text in any log call.
      const logged = JSON.stringify([
        vi.mocked(s.logger.info).mock.calls,
        vi.mocked(s.logger.warn).mock.calls,
        vi.mocked(s.logger.error).mock.calls,
      ]);
      expect(logged).not.toContain('How are you');
      expect(logged).not.toContain('Tudo bem com você?');
    } finally {
      vi.useRealTimers();
    }
  });

  it('off → suggestions run directly on the original', async () => {
    vi.useFakeTimers();
    try {
      const s = await runTheirSpeech({
        stored: { sttEngine: 'openai', translateTheirSpeech: false },
      });
      expect(s.log).toEqual(['fetch:suggest']);
      expect(s.h.getTranscript()[0]?.translated).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a translation failure still triggers suggestions', async () => {
    vi.useFakeTimers();
    try {
      const s = await runTheirSpeech({
        stored: { sttEngine: 'openai', translateTheirSpeech: true },
        chat: (kind) =>
          kind === 'translate'
            ? jsonResponse({ error: 'boom' }, 500)
            : chatResponse('{"suggestions":[{"text":"Claro","translation":"Sure"}]}'),
      });
      expect(s.log).toEqual(['fetch:translate', 'fetch:suggest']);
      expect(s.h.getTranscript()[0]?.translated).toBe('');
      expect(s.logger.warn).toHaveBeenCalledWith('their_speech_translate_failed', {
        code: 'unknown',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// LLM handlers
// ---------------------------------------------------------------------------

describe('AssistantRuntime LLM handlers', () => {
  const ollama = { llm: { preset: 'ollama' as const, ...LLM_PRESETS.ollama } };

  it('never sends the OpenAI key to an http://127.0.0.1 base URL', async () => {
    const s = setup({ stored: ollama, key: 'sk-openai-secret' });
    const r = await s.h.testLlm();
    expect(r.ok).toBe(true);
    const call = s.fetchCalls[0]!;
    expect(call.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(call.headers.Authorization).toBeUndefined();

    s.setLlmKey('local-key');
    await s.h.testLlm();
    expect(s.fetchCalls[1]!.headers.Authorization).toBe('Bearer local-key');
  });

  it('uses the OpenAI key for the OpenAI host', async () => {
    const s = setup({ key: 'sk-openai' });
    await s.h.testLlm();
    expect(s.fetchCalls[0]!.headers.Authorization).toBe('Bearer sk-openai');
  });

  it('testLlm with empty content → llm-bad-response', async () => {
    const s = setup({ key: 'sk', chat: () => chatResponse('') });
    expect(await s.h.testLlm()).toEqual({ ok: false, code: 'llm-bad-response' });
  });

  it('listLlmModels returns sorted ids; LLM key hint shows the last 4', async () => {
    const s = setup({ stored: ollama });
    expect(await s.h.listLlmModels()).toEqual({ ok: true, models: ['a', 'b'] });
    expect(s.h.getLlmKeyHint()).toBeUndefined();
    s.h.setLlmKey('abcdefgh');
    expect(s.h.getLlmKeyHint()).toBe('efgh');
    s.h.clearLlmKey();
    expect(s.h.getLlmKeyHint()).toBeUndefined();
  });

  it('exportTranscript formats the snapshot and passes the sender through', async () => {
    const s = setup();
    s.rt.onTranslateDelta({ direction: 'A', kind: 'input', text: 'Olá' });
    const sender = { id: 7 };
    const r = await s.h.exportTranscript('md', sender as never);
    expect(r).toEqual({ saved: true });
    const call = vi.mocked(s.win.saveExport).mock.calls[0]!;
    expect(call[0]).toBe('md');
    expect(call[1]).toContain('Olá');
    expect(call[2]).toBe(sender);
  });

  it('dispose stops STT and clears the tick', async () => {
    const s = setup({
      stored: { sttEngine: 'openai' },
      key: 'sk-test',
      audio: { sttStreams: PASS_BOTH },
    });
    await s.rt.syncAudio();
    s.rt.onTranslateStart();
    await s.rt.dispose();
    expect(tapsOff(s.taps)).toEqual(['pass-A', 'pass-B']);
    expect(s.clearedIntervals()).toBe(1);
  });
});
