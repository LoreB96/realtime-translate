import { describe, it, expect, vi } from 'vitest';
import {
  IDLE_CLOSE_MS,
  TTS_URL,
  TtsError,
  TtsService,
  buildTtsBody,
  type TtsPlaybackSink,
  type TtsServiceDeps,
  type TtsStreamId,
  ttsInstructions,
} from '@main/tts/ttsService';
import type { FetchLike, FetchResponseLike } from '@main/util/fetchLike';
import type { Logger } from '@main/util/logger';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A response body the test feeds by hand. */
class FakeBody {
  private readonly buffered: Uint8Array[] = [];
  private readonly waiters: ((r: ReadableStreamReadResult<Uint8Array>) => void)[] = [];
  private ended = false;
  cancelled = false;

  push(bytes: Uint8Array): void {
    const w = this.waiters.shift();
    if (w) w({ done: false, value: bytes });
    else this.buffered.push(bytes);
  }

  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ done: true, value: undefined });
  }

  asStream(): ReadableStream<Uint8Array> {
    const reader = {
      read: (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        const b = this.buffered.shift();
        if (b) return Promise.resolve({ done: false, value: b });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((r) => this.waiters.push(r));
      },
      cancel: (): Promise<void> => {
        this.cancelled = true;
        this.end();
        return Promise.resolve();
      },
    };
    return { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
  }
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

type Responder = (call: FetchCall) => Promise<FetchResponseLike>;

class FakeFetch {
  calls: FetchCall[] = [];
  private readonly responders: Responder[] = [];

  next(r: Responder): void {
    this.responders.push(r);
  }

  /** Queue a 200 response whose body the test controls. */
  nextBody(): FakeBody {
    const body = new FakeBody();
    this.next(() => Promise.resolve(okResponse(body)));
    return body;
  }

  readonly fn: FetchLike = (url, init) => {
    const call: FetchCall = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body ?? '{}') as Record<string, unknown>,
      signal: init.signal,
    };
    this.calls.push(call);
    const r = this.responders.shift();
    if (!r) return Promise.reject(new Error('no responder'));
    return r(call);
  };
}

function okResponse(body: FakeBody | null, status = 200): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    body: body ? body.asStream() : null,
  };
}

class FakeSink implements TtsPlaybackSink {
  log: string[] = [];
  pushes: { id: TtsStreamId; b64: string }[] = [];
  failOpen = false;
  open(streamId: TtsStreamId, deviceId: string): Promise<void> {
    this.log.push(`open:${streamId}:${deviceId}`);
    return this.failOpen ? Promise.reject(new Error('boom')) : Promise.resolve();
  }
  push(streamId: TtsStreamId, b64: string): void {
    this.pushes.push({ id: streamId, b64 });
  }
  close(streamId: TtsStreamId): void {
    this.log.push(`close:${streamId}`);
  }
}

function fakeLogger(): Logger & { events: { event: string; data?: Record<string, unknown> }[] } {
  const events: { event: string; data?: Record<string, unknown> }[] = [];
  const rec = (event: string, data?: Record<string, unknown>): void => {
    events.push(data ? { event, data } : { event });
  };
  return { events, debug: rec, info: rec, warn: rec, error: rec };
}

interface Setup {
  svc: TtsService;
  fetch: FakeFetch;
  sink: FakeSink;
  logger: ReturnType<typeof fakeLogger>;
  state: {
    key: string | undefined;
    busy: boolean;
    devices: { toMeet?: string; headset?: string };
    prefs: { voice: string; model: string; monitor: boolean };
  };
}

function setup(over: Partial<TtsServiceDeps> = {}): Setup {
  const fetch = new FakeFetch();
  const sink = new FakeSink();
  const logger = fakeLogger();
  const state: Setup['state'] = {
    key: 'sk-test',
    busy: false,
    devices: { toMeet: 'cable-a' },
    prefs: { voice: 'alloy', model: 'gpt-4o-mini-tts', monitor: false },
  };
  const svc = new TtsService({
    fetch: fetch.fn,
    apiKey: () => state.key,
    devices: () => state.devices,
    prefs: () => state.prefs,
    busy: () => state.busy,
    sink,
    now: () => Date.now(),
    logger,
    ...over,
  });
  return { svc, fetch, sink, logger, state };
}

/** `ms` of PCM16 at 24 kHz. */
const pcm = (ms: number): Uint8Array => new Uint8Array((ms * 24000 * 2) / 1000);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    if (e instanceof TtsError) return e.code;
    if (e instanceof Error) return e.name;
    return 'thrown';
  }
}

/** Track a promise's settlement without awaiting it. */
function track(p: Promise<void>): { settled: () => string | undefined } {
  let s: string | undefined;
  p.then(
    () => (s = 'resolved'),
    (e: unknown) => (s = e instanceof TtsError ? e.code : e instanceof Error ? e.name : 'x'),
  );
  return { settled: () => s };
}

// ---------------------------------------------------------------------------

describe('buildTtsBody', () => {
  it('adds instructions with the language name only for gpt-4o-mini-tts models', () => {
    expect(buildTtsBody('gpt-4o-mini-tts', 'alloy', 'ciao', 'it')).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: 'ciao',
      response_format: 'pcm',
      instructions: ttsInstructions('Italian'),
    });
    expect(buildTtsBody('gpt-4o-mini-tts-2025-03-20', 'ash', 'x', 'en').instructions).toBe(
      ttsInstructions('English'),
    );
    const plain = buildTtsBody('tts-1', 'alloy', 'x', 'en');
    expect('instructions' in plain).toBe(false);
  });

  it('asks for native pronunciation in the target language', () => {
    expect(ttsInstructions('Italian')).toMatch(/native Italian speaker/);
    expect(ttsInstructions('Italian')).toMatch(/no foreign accent/);
  });
});

describe('TtsService', () => {
  it('posts to the speech endpoint with key, voice, model and pcm format', async () => {
    vi.useFakeTimers();
    try {
      const { svc, fetch, state } = setup();
      state.prefs = { voice: 'coral', model: 'gpt-4o-mini-tts', monitor: false };
      const body = fetch.nextBody();
      const p = svc.speak('Olá', 'pt');
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch.calls).toHaveLength(1);
      const call = fetch.calls[0];
      expect(call?.url).toBe(TTS_URL);
      expect(TTS_URL).toBe('https://api.openai.com/v1/audio/speech');
      expect(call?.headers.Authorization).toBe('Bearer sk-test');
      expect(call?.headers['Content-Type']).toBe('application/json');
      expect(call?.body).toMatchObject({
        model: 'gpt-4o-mini-tts',
        voice: 'coral',
        input: 'Olá',
        response_format: 'pcm',
        instructions: ttsInstructions('Portuguese'),
      });
      body.push(pcm(100));
      body.end();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await codeOf(p)).toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks busy first, then key, then device, then input length, before any request', async () => {
    const { svc, fetch, state, sink, logger } = setup();
    state.busy = true;
    state.key = undefined;
    state.devices = {};
    expect(await codeOf(svc.speak('hi', 'en'))).toBe('tts-busy-setup');
    state.busy = false;
    expect(await codeOf(svc.speak('hi', 'en'))).toBe('no-openai-key');
    state.key = 'sk';
    expect(await codeOf(svc.speak('hi', 'en'))).toBe('tts-no-device');
    state.devices = { toMeet: 'cable-a' };
    expect(await codeOf(svc.speak('x'.repeat(4097), 'en'))).toBe('tts-failed');
    expect(fetch.calls).toHaveLength(0);
    expect(sink.log).toEqual([]);
    const tooLong = logger.events.find((e) => e.event === 'tts_input_too_long');
    expect(tooLong?.data).toEqual({ chars: 4097 });
    const codes = logger.events.filter((e) => e.event === 'tts_failed').map((e) => e.data?.code);
    expect(codes).toEqual(['tts-busy-setup', 'no-openai-key', 'tts-no-device', 'tts-failed']);
  });

  it('opens, pushes, and resolves at firstPushAt + duration + 300 ms with a slow download', async () => {
    vi.useFakeTimers();
    try {
      const { svc, fetch, sink, logger } = setup();
      const body = fetch.nextBody();
      const firstAudio = vi.fn();
      const t0 = Date.now();
      const t = track(svc.speak('hello', 'en', { onFirstAudio: firstAudio }));
      await vi.advanceTimersByTimeAsync(0);
      expect(sink.log).toEqual(['open:tts:cable-a']);
      body.push(pcm(1000)); // 1 s of audio arrives at t0
      await vi.advanceTimersByTimeAsync(0);
      expect(sink.pushes).toHaveLength(10);
      expect(sink.pushes.every((p) => p.id === 'tts')).toBe(true);
      expect(firstAudio).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      body.push(pcm(500)); // another 0.5 s arrives 500 ms later
      body.end();
      await vi.advanceTimersByTimeAsync(0);
      expect(sink.pushes).toHaveLength(15);
      expect(firstAudio).toHaveBeenCalledTimes(1);
      // Done = t0 + 1500 + 300 = t0 + 1800 (not last chunk + duration, which would be 2300).
      await vi.advanceTimersByTimeAsync(t0 + 1799 - Date.now());
      expect(t.settled()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(t.settled()).toBe('resolved');
      const done = logger.events.find((e) => e.event === 'tts_done');
      expect(done?.data).toEqual({ chars: 5, ms: 1800, samples: 36000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('mirrors into tts-mon only when monitoring and a headset is set', async () => {
    vi.useFakeTimers();
    try {
      const { svc, fetch, sink, state } = setup();
      state.prefs = { ...state.prefs, monitor: true };
      state.devices = { toMeet: 'cable-a', headset: 'phones' };
      let body = fetch.nextBody();
      const p1 = svc.speak('a', 'en');
      await vi.advanceTimersByTimeAsync(0);
      body.push(pcm(100));
      body.end();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await codeOf(p1)).toBe('resolved');
      expect(sink.log).toEqual(['open:tts:cable-a', 'open:tts-mon:phones']);
      expect(sink.pushes.map((p) => p.id)).toEqual(['tts', 'tts-mon']);

      // Monitor turned off: the open tts-mon stream is closed and no longer fed.
      state.prefs = { ...state.prefs, monitor: false };
      sink.log = [];
      sink.pushes = [];
      body = fetch.nextBody();
      const p2 = svc.speak('b', 'en');
      await vi.advanceTimersByTimeAsync(0);
      body.push(pcm(100));
      body.end();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await codeOf(p2)).toBe('resolved');
      expect(sink.log).toEqual(['open:tts:cable-a', 'close:tts-mon']);
      expect(sink.pushes.map((p) => p.id)).toEqual(['tts']);

      // Monitor on without a headset: no tts-mon.
      state.prefs = { ...state.prefs, monitor: true };
      state.devices = { toMeet: 'cable-a' };
      sink.log = [];
      sink.pushes = [];
      body = fetch.nextBody();
      const p3 = svc.speak('c', 'en');
      await vi.advanceTimersByTimeAsync(0);
      body.push(pcm(100));
      body.end();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await codeOf(p3)).toBe('resolved');
      expect(sink.log).toEqual(['open:tts:cable-a']);
      expect(sink.pushes.map((p) => p.id)).toEqual(['tts']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is FIFO: the next request starts only after the previous item finished', async () => {
    vi.useFakeTimers();
    try {
      const { svc, fetch } = setup();
      const b1 = fetch.nextBody();
      const b2 = fetch.nextBody();
      const t1 = track(svc.speak('one', 'en'));
      const t2 = track(svc.speak('two', 'en'));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch.calls.map((c) => c.body.input)).toEqual(['one']);
      b1.push(pcm(200));
      b1.end();
      await vi.advanceTimersByTimeAsync(499);
      expect(fetch.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(t1.settled()).toBe('resolved');
      expect(fetch.calls.map((c) => c.body.input)).toEqual(['one', 'two']);
      b2.push(pcm(100));
      b2.end();
      await vi.advanceTimersByTimeAsync(400);
      expect(t2.settled()).toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopAll aborts the current item, rejects the queue, closes both streams, drops late chunks', async () => {
    vi.useFakeTimers();
    try {
      const { svc, fetch, sink } = setup();
      const b1 = fetch.nextBody();
      const t1 = track(svc.speak('one', 'en'));
      const t2 = track(svc.speak('two', 'en'));
      await vi.advanceTimersByTimeAsync(0);
      b1.push(pcm(100));
      await vi.advanceTimersByTimeAsync(0);
      expect(sink.pushes).toHaveLength(1);
      svc.stopAll();
      expect(fetch.calls[0]?.signal?.aborted).toBe(true);
      b1.push(pcm(100));
      await vi.advanceTimersByTimeAsync(0);
      expect(t1.settled()).toBe('AbortError');
      expect(t2.settled()).toBe('AbortError');
      expect(sink.pushes).toHaveLength(1);
      expect(sink.log).toContain('close:tts');
      expect(sink.log).toContain('close:tts-mon');
      expect(b1.cancelled).toBe(true);
      expect(fetch.calls).toHaveLength(1);

      // The service keeps working after a stop.
      const b3 = fetch.nextBody();
      const t3 = track(svc.speak('three', 'en'));
      await vi.advanceTimersByTimeAsync(0);
      b3.push(pcm(100));
      b3.end();
      await vi.advanceTimersByTimeAsync(400);
      expect(t3.settled()).toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopAll during the playout wait rejects the item', async () => {
    vi.useFakeTimers();
    try {
      const { svc, fetch } = setup();
      const b = fetch.nextBody();
      const t = track(svc.speak('one', 'en'));
      await vi.advanceTimersByTimeAsync(0);
      b.push(pcm(1000));
      b.end();
      await vi.advanceTimersByTimeAsync(500);
      expect(t.settled()).toBeUndefined();
      svc.stopAll();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.settled()).toBe('AbortError');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an external abort signal rejects with AbortError', async () => {
    vi.useFakeTimers();
    try {
      const { svc, fetch } = setup();
      fetch.nextBody();
      const ac = new AbortController();
      const t = track(svc.speak('one', 'en', { signal: ac.signal }));
      await vi.advanceTimersByTimeAsync(0);
      ac.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.settled()).toBe('AbortError');
      const pre = new AbortController();
      pre.abort();
      expect(await codeOf(svc.speak('two', 'en', { signal: pre.signal }))).toBe('AbortError');
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps 429 to rate-limited, other errors and a null body to tts-failed', async () => {
    const { svc, fetch, logger } = setup();
    fetch.next(() => Promise.resolve(okResponse(null, 429)));
    expect(await codeOf(svc.speak('a', 'en'))).toBe('rate-limited');
    fetch.next(() => Promise.resolve(okResponse(null, 500)));
    expect(await codeOf(svc.speak('a', 'en'))).toBe('tts-failed');
    fetch.next(() => Promise.resolve(okResponse(null, 200)));
    expect(await codeOf(svc.speak('a', 'en'))).toBe('tts-failed');
    fetch.next(() => Promise.reject(new TypeError('fetch failed')));
    expect(await codeOf(svc.speak('a', 'en'))).toBe('tts-failed');
    const failed = logger.events.filter((e) => e.event === 'tts_failed');
    expect(failed.map((e) => e.data?.code)).toEqual([
      'rate-limited',
      'tts-failed',
      'tts-failed',
      'tts-failed',
    ]);
    expect(failed[0]?.data?.status).toBe(429);
    expect(failed[1]?.data?.status).toBe(500);
    // No log line carries the spoken text.
    expect(JSON.stringify(logger.events)).not.toContain('"a"');
  });

  it('an empty body or a failing sink.open is tts-failed', async () => {
    const { svc, fetch, sink } = setup();
    const b = fetch.nextBody();
    b.end();
    expect(await codeOf(svc.speak('a', 'en'))).toBe('tts-failed');
    sink.failOpen = true;
    expect(await codeOf(svc.speak('a', 'en'))).toBe('tts-failed');
    expect(fetch.calls).toHaveLength(1);
  });

  it('closes the streams after 30 s idle; a new item in time keeps them open', async () => {
    vi.useFakeTimers();
    try {
      const { svc, fetch, sink, state } = setup();
      state.prefs = { ...state.prefs, monitor: true };
      state.devices = { toMeet: 'cable-a', headset: 'phones' };
      const speakOnce = async (): Promise<void> => {
        const b = fetch.nextBody();
        const t = track(svc.speak('x', 'en'));
        await vi.advanceTimersByTimeAsync(0);
        b.push(pcm(100));
        b.end();
        await vi.advanceTimersByTimeAsync(400);
        expect(t.settled()).toBe('resolved');
      };
      await speakOnce();
      await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 1000);
      await speakOnce(); // restarts the idle timer
      await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 1);
      expect(sink.log.filter((l) => l.startsWith('close'))).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sink.log.filter((l) => l.startsWith('close')).sort()).toEqual([
        'close:tts',
        'close:tts-mon',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
