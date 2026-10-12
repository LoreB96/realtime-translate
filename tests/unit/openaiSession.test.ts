import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAISession, type SessionEvents, type WebSocketLike, type WebSocketFactory } from '@main/translate/openaiSession';

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;
  onopen?: () => void;
  onclose?: (code: number, reason: string) => void;
  onmessage?: (data: string) => void;
  onerror?: (err: Error) => void;

  constructor(public url: string, public headers: Record<string, string>) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.(code ?? 1000, reason ?? '');
  }
  // helpers for tests
  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  simulateMessage(payload: object) {
    this.onmessage?.(JSON.stringify(payload));
  }
  simulateError(err: Error) {
    this.onerror?.(err);
  }
}

const fakeFactory: WebSocketFactory = (url, headers) => new FakeWebSocket(url, headers);

const fakeLogger = (): { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('OpenAISession', () => {
  let events: SessionEvents;
  let onState: ReturnType<typeof vi.fn>;
  let onAudio: ReturnType<typeof vi.fn>;
  let onTranscript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    onState = vi.fn();
    onAudio = vi.fn();
    onTranscript = vi.fn();
    events = { onState, onAudio, onTranscript };
  });

  it('opens connection with correct URL and headers, then sends session.update', async () => {
    const session = new OpenAISession({
      apiKey: 'sk-test',
      sourceLang: 'pt',
      targetLang: 'en',
      events,
      wsFactory: fakeFactory,
    });
    session.start();

    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate');
    expect(ws.headers.Authorization).toBe('Bearer sk-test');

    ws.simulateOpen();

    expect(ws.sent).toHaveLength(1);
    const config = JSON.parse(ws.sent[0]!);
    expect(config.type).toBe('session.update');
    expect(config.session.audio.output.language).toBe('en');
    // The /v1/realtime/translations endpoint does NOT accept input_audio_format
    // or output_audio_format — those belong to the conversational /v1/realtime
    // endpoint. Translation format is implicitly PCM16 24kHz mono.
    expect(config.session.input_audio_format).toBeUndefined();
    expect(config.session.output_audio_format).toBeUndefined();
  });

  it('emits state transitions: connecting -> active', () => {
    const session = new OpenAISession({
      apiKey: 'sk',
      sourceLang: 'pt',
      targetLang: 'en',
      events,
      wsFactory: fakeFactory,
    });
    session.start();
    expect(onState).toHaveBeenCalledWith({ kind: 'connecting' });
    FakeWebSocket.instances[0]!.simulateOpen();
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'active' }));
  });

  it('appendAudio sends input_audio_buffer.append', () => {
    const session = new OpenAISession({
      apiKey: 'sk',
      sourceLang: 'pt',
      targetLang: 'en',
      events,
      wsFactory: fakeFactory,
    });
    session.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.sent = []; // reset

    session.appendAudio('base64audiochunk');
    const msg = JSON.parse(ws.sent[0]!);
    expect(msg.type).toBe('session.input_audio_buffer.append');
    expect(msg.audio).toBe('base64audiochunk');
  });

  it('emits audio delta events', () => {
    const session = new OpenAISession({
      apiKey: 'sk',
      sourceLang: 'pt',
      targetLang: 'en',
      events,
      wsFactory: fakeFactory,
    });
    session.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage({ type: 'session.output_audio.delta', delta: 'b64chunk' });
    expect(onAudio).toHaveBeenCalledWith('b64chunk');
  });

  it('emits transcript deltas', () => {
    const session = new OpenAISession({
      apiKey: 'sk',
      sourceLang: 'pt',
      targetLang: 'en',
      events,
      wsFactory: fakeFactory,
    });
    session.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage({ type: 'session.input_transcript.delta', delta: 'olá' });
    ws.simulateMessage({ type: 'session.output_transcript.delta', delta: 'hello' });
    expect(onTranscript).toHaveBeenCalledWith({ kind: 'input', text: 'olá' });
    expect(onTranscript).toHaveBeenCalledWith({ kind: 'output', text: 'hello' });
  });

  it('stop() closes the socket and emits idle state', () => {
    const session = new OpenAISession({
      apiKey: 'sk',
      sourceLang: 'pt',
      targetLang: 'en',
      events,
      wsFactory: fakeFactory,
    });
    session.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    session.stop();
    expect(ws.closed).toBe(true);
    expect(onState).toHaveBeenLastCalledWith({ kind: 'idle' });
  });

  it('appendAudio before open is silently buffered until open', () => {
    const session = new OpenAISession({
      apiKey: 'sk',
      sourceLang: 'pt',
      targetLang: 'en',
      events,
      wsFactory: fakeFactory,
    });
    session.start();
    session.appendAudio('chunk1');
    session.appendAudio('chunk2');
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.sent).toHaveLength(0);
    ws.simulateOpen();
    // After open: session.update + 2 buffered chunks
    expect(ws.sent).toHaveLength(3);
    expect(JSON.parse(ws.sent[1]!).audio).toBe('chunk1');
    expect(JSON.parse(ws.sent[2]!).audio).toBe('chunk2');
  });

  // ---------- Task 9b: reconnect + cleanup ----------

  it('unexpected close schedules reconnect with delay (emits reconnecting)', () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
        backoff: { baseMs: 100, maxMs: 1000, maxAttempts: 5 },
      });
      session.start();
      const ws1 = FakeWebSocket.instances[0]!;
      ws1.simulateOpen();

      // Simulate unexpected close (server side) — readyState->3, onclose fires.
      ws1.close(1006, 'abnormal');

      // Should have emitted 'reconnecting' with attempt 1.
      expect(onState).toHaveBeenCalledWith({ kind: 'reconnecting', attempt: 1 });

      // No new socket yet — still waiting on the timer.
      expect(FakeWebSocket.instances).toHaveLength(1);

      // Advance time past first delay (100ms).
      vi.advanceTimersByTime(100);

      // Reconnect attempted: a new socket exists.
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnect success restores active state and resets backoff', () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
        backoff: { baseMs: 100, maxMs: 1000, maxAttempts: 5 },
      });
      session.start();
      const ws1 = FakeWebSocket.instances[0]!;
      ws1.simulateOpen();
      ws1.close(1006, 'abnormal');
      vi.advanceTimersByTime(100);

      const ws2 = FakeWebSocket.instances[1]!;
      ws2.simulateOpen();

      // Last state should be active again.
      expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'active' }));

      // After reconnect success, drop ws2 unexpectedly. Backoff should have reset
      // so the next attempt counter starts at 1 again.
      onState.mockClear();
      ws2.close(1006, 'abnormal');
      expect(onState).toHaveBeenCalledWith({ kind: 'reconnecting', attempt: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() while reconnecting cancels the pending timer', () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
        backoff: { baseMs: 100, maxMs: 1000, maxAttempts: 5 },
      });
      session.start();
      const ws1 = FakeWebSocket.instances[0]!;
      ws1.simulateOpen();
      ws1.close(1006, 'abnormal');
      // We are now in 'reconnecting' state with a pending timer.
      expect(onState).toHaveBeenCalledWith({ kind: 'reconnecting', attempt: 1 });

      // User stops the session before reconnect timer fires.
      session.stop();

      // Advance past delay — no new socket should be created.
      vi.advanceTimersByTime(500);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnect attempts exhausted emits final error', () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
        backoff: { baseMs: 10, maxMs: 100, maxAttempts: 2 },
      });
      session.start();

      // Open succeeds once, then a close-without-reopen sequence drains all
      // reconnect attempts. We do NOT call simulateOpen between retries —
      // a successful open would reset backoff and defeat the test.
      const ws1 = FakeWebSocket.instances[0]!;
      ws1.simulateOpen();
      ws1.close(1006, 'abnormal'); // attempt 1 scheduled
      vi.advanceTimersByTime(10);

      const ws2 = FakeWebSocket.instances[1]!;
      // Don't open ws2 — close it while still connecting, simulating a failed retry.
      ws2.close(1006, 'abnormal'); // attempt 2 scheduled
      vi.advanceTimersByTime(20);

      const ws3 = FakeWebSocket.instances[2]!;
      ws3.close(1006, 'abnormal'); // attempts exhausted

      expect(onState).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'error', message: expect.stringMatching(/reconnect attempts exhausted/i) })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('server-side {type:"error"} events are logged, not latched: session stays active and a later drop reconnects', () => {
    vi.useFakeTimers();
    try {
      const logger = fakeLogger();
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
        backoff: { baseMs: 50, maxMs: 500, maxAttempts: 5 },
        logger,
      });
      session.start();
      const ws = FakeWebSocket.instances[0]!;
      ws.simulateOpen();
      onState.mockClear();

      ws.simulateMessage({
        type: 'error',
        error: { type: 'invalid_request_error', code: 'some_code', message: 'recoverable' },
      });
      // Recoverable per docs: no error state, audio keeps flowing.
      expect(onState).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('server_error_event', {
        code: 'some_code',
        type: 'invalid_request_error',
        message: 'recoverable',
      });
      session.appendAudio('chunk');
      expect(ws.sent.some((s) => s.includes('chunk'))).toBe(true);

      // A later network drop is still recovered.
      ws.close(1006, 'abnormal');
      expect(onState).toHaveBeenCalledWith({ kind: 'reconnecting', attempt: 1 });
      vi.advanceTimersByTime(60);
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exhausted reconnects report the last server error message', () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
        backoff: { baseMs: 10, maxMs: 100, maxAttempts: 1 },
      });
      session.start();
      const ws1 = FakeWebSocket.instances[0]!;
      ws1.simulateOpen();
      ws1.simulateMessage({ type: 'error', error: { message: 'invalid_session_config' } });
      ws1.close(1006, 'abnormal'); // attempt 1 scheduled
      vi.advanceTimersByTime(10);
      FakeWebSocket.instances[1]!.close(1006, 'abnormal'); // exhausted
      expect(onState).toHaveBeenLastCalledWith({
        kind: 'error',
        message: 'reconnect attempts exhausted: invalid_session_config',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('open → error → close cycles still exhaust the backoff (no infinite reconnect loop)', () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
        backoff: { baseMs: 10, maxMs: 100, maxAttempts: 3 },
      });
      session.start();
      for (let i = 0; i < 10; i++) {
        const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
        if (ws.closed) break;
        ws.simulateOpen();
        ws.simulateMessage({ type: 'error', error: { code: 'insufficient_quota', message: 'quota' } });
        ws.close(1000, '');
        vi.advanceTimersByTime(200);
      }
      expect(FakeWebSocket.instances).toHaveLength(4); // initial + 3 attempts
      expect(onState).toHaveBeenLastCalledWith({
        kind: 'error',
        message: 'reconnect attempts exhausted: quota',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('translated audio after a reconnect clears the stale server error and resets backoff', () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
        backoff: { baseMs: 10, maxMs: 100, maxAttempts: 1 },
      });
      session.start();
      const ws1 = FakeWebSocket.instances[0]!;
      ws1.simulateOpen();
      ws1.simulateMessage({ type: 'error', error: { message: 'old error' } });
      ws1.close(1006, '');
      vi.advanceTimersByTime(20);
      const ws2 = FakeWebSocket.instances[1]!;
      ws2.simulateOpen();
      ws2.simulateMessage({ type: 'session.output_audio.delta', delta: 'ok' });
      // Healthy again: a later plain drop gets a fresh attempt and no stale message.
      ws2.close(1006, '');
      expect(onState).toHaveBeenLastCalledWith({ kind: 'reconnecting', attempt: 1 });
      vi.advanceTimersByTime(20);
      FakeWebSocket.instances[2]!.close(1006, '');
      expect(onState).toHaveBeenLastCalledWith({ kind: 'error', message: 'reconnect attempts exhausted' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('handshake rejected with 401 is fatal: error state, no reconnect', () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAISession({
        apiKey: 'sk-bad',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
        backoff: { baseMs: 50, maxMs: 500, maxAttempts: 5 },
      });
      session.start();
      const ws = FakeWebSocket.instances[0]!;
      // ws library order on a rejected upgrade: 'error' then close(1006).
      ws.simulateError(new Error('Unexpected server response: 401'));
      ws.close(1006, '');
      vi.advanceTimersByTime(2000);
      expect(onState).toHaveBeenLastCalledWith({
        kind: 'error',
        message: 'Unexpected server response: 401',
      });
      expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'reconnecting' }));
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('transient handshake failure (e.g. 503) still reconnects', () => {
    vi.useFakeTimers();
    try {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
        backoff: { baseMs: 50, maxMs: 500, maxAttempts: 5 },
      });
      session.start();
      const ws = FakeWebSocket.instances[0]!;
      ws.simulateError(new Error('Unexpected server response: 503'));
      ws.close(1006, '');
      expect(onState).toHaveBeenLastCalledWith({ kind: 'reconnecting', attempt: 1 });
      vi.advanceTimersByTime(60);
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() while CONNECTING ends idle: the ws abort error and late frames are ignored', () => {
    const session = new OpenAISession({
      apiKey: 'sk',
      sourceLang: 'pt',
      targetLang: 'en',
      events,
      wsFactory: fakeFactory,
    });
    session.start();
    const ws = FakeWebSocket.instances[0]!;
    session.stop();
    // ws emits this asynchronously after close() on a CONNECTING socket.
    ws.simulateError(new Error('WebSocket was closed before the connection was established'));
    ws.simulateMessage({ type: 'session.output_audio.delta', delta: 'late' });
    expect(onState).toHaveBeenLastCalledWith({ kind: 'idle' });
    expect(onAudio).not.toHaveBeenCalled();
  });

  it('stop() clears pendingAudio so stale chunks do not leak across sessions', () => {
    const session = new OpenAISession({
      apiKey: 'sk',
      sourceLang: 'pt',
      targetLang: 'en',
      events,
      wsFactory: fakeFactory,
    });
    session.start();
    // Buffer some audio before open.
    session.appendAudio('stale-1');
    session.appendAudio('stale-2');
    // Stop before connection ever opens.
    session.stop();

    // Now start a fresh session.
    session.start();
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.simulateOpen();
    // Only session.update should have been sent — no leaked stale chunks.
    expect(ws2.sent).toHaveLength(1);
    expect(JSON.parse(ws2.sent[0]!).type).toBe('session.update');
  });

  it('pendingAudio is bounded — drops oldest after cap', () => {
    const session = new OpenAISession({
      apiKey: 'sk',
      sourceLang: 'pt',
      targetLang: 'en',
      events,
      wsFactory: fakeFactory,
    });
    session.start();
    // Push 205 chunks before open. Cap is 200.
    for (let i = 0; i < 205; i++) {
      session.appendAudio(`chunk-${i}`);
    }
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    // session.update + 200 buffered chunks (oldest 5 dropped).
    expect(ws.sent).toHaveLength(1 + 200);
    // First buffered chunk should be chunk-5 (chunk-0..chunk-4 dropped).
    expect(JSON.parse(ws.sent[1]!).audio).toBe('chunk-5');
    expect(JSON.parse(ws.sent[200]!).audio).toBe('chunk-204');
  });

  it('reconnect discards stale pending audio (live > stale for real-time translation)', () => {
    // Replaying buffered audio on reconnect shifts OpenAI's input pipeline
    // permanently behind real-time, compounding latency. Drop instead.
    vi.useFakeTimers();
    try {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
        backoff: { baseMs: 100, maxMs: 1000, maxAttempts: 5 },
      });
      session.start();
      const ws1 = FakeWebSocket.instances[0]!;
      ws1.simulateOpen();
      // First connect already happened; clear the session.update that landed on ws1.
      ws1.close(1006, 'abnormal');

      // Mic continues capturing during the reconnect window — feed stale chunks.
      for (let i = 0; i < 50; i++) {
        session.appendAudio(`stale-${i}`);
      }

      // Reconnect succeeds.
      vi.advanceTimersByTime(100);
      const ws2 = FakeWebSocket.instances[1]!;
      ws2.simulateOpen();

      // ws2 should have ONLY session.update — stale audio is discarded.
      expect(ws2.sent).toHaveLength(1);
      expect(JSON.parse(ws2.sent[0]!).type).toBe('session.update');
    } finally {
      vi.useRealTimers();
    }
  });

  it('overflow log fires once per overflow event, not per chunk', () => {
    const logger = fakeLogger();
    const session = new OpenAISession({
      apiKey: 'sk', sourceLang: 'pt', targetLang: 'en', events,
      wsFactory: fakeFactory, logger,
    });
    session.start();
    for (let i = 0; i < 205; i++) session.appendAudio(`chunk-${i}`);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('pending_audio_overflow');
  });

  it('warns on malformed JSON messages instead of silently dropping', () => {
    const logger = fakeLogger();
    const session = new OpenAISession({
      apiKey: 'sk', sourceLang: 'pt', targetLang: 'en', events,
      wsFactory: fakeFactory, logger,
    });
    session.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.onmessage?.('not-valid-json{{{');
    expect(logger.warn).toHaveBeenCalledWith('malformed_message_ignored');
  });

  it('does not emit active when onopen fires late after stop()', () => {
    const session = new OpenAISession({
      apiKey: 'sk',
      sourceLang: 'pt',
      targetLang: 'en',
      events,
      wsFactory: fakeFactory,
    });
    session.start();
    // Don't call simulateOpen yet — connection still pending
    session.stop();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen(); // late onopen, after stop()
    // Last state must be idle (from stop), not active
    expect(onState).toHaveBeenLastCalledWith({ kind: 'idle' });
  });

  it('measures and emits latency: t1 - t0 average over last 5 turns', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T00:00:00Z'));
    try {
      const onLatency = vi.fn();
      const session = new OpenAISession({
        apiKey: 'sk', sourceLang: 'pt', targetLang: 'en',
        events: { ...events, onLatencyMeasured: onLatency },
        wsFactory: fakeFactory,
      });
      session.start();
      const ws = FakeWebSocket.instances[0]!;
      ws.simulateOpen();

      // Turn 1: send audio at t=0, receive delta at t=1500ms
      session.appendAudio('chunk-1');
      vi.advanceTimersByTime(1500);
      ws.simulateMessage({ type: 'session.output_audio.delta', delta: 'reply-1' });

      // Turn 1 complete — average of [1500] = 1500
      expect(onLatency).toHaveBeenLastCalledWith({ averageMs: 1500, sampleCount: 1 });

      // Turn 2: send at +500ms, receive at +2000ms (turn duration 1500ms)
      vi.advanceTimersByTime(500);
      session.appendAudio('chunk-2');
      vi.advanceTimersByTime(1500);
      ws.simulateMessage({ type: 'session.output_audio.delta', delta: 'reply-2' });

      expect(onLatency).toHaveBeenLastCalledWith({ averageMs: 1500, sampleCount: 2 });

      // Turn 3-7: vary durations to verify ring buffer of 5
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(100);
        session.appendAudio(`chunk-extra-${i}`);
        vi.advanceTimersByTime(1000 + i * 200); // 1000, 1200, 1400, 1600, 1800
        ws.simulateMessage({ type: 'session.output_audio.delta', delta: `reply-extra-${i}` });
      }

      // 7 turns total: [1500, 1500, 1000, 1200, 1400, 1600, 1800]. Ring buffer of 5
      // keeps the 5 most recent: [1000, 1200, 1400, 1600, 1800].
      // Average = (1000 + 1200 + 1400 + 1600 + 1800) / 5 = 1400
      const lastCall = onLatency.mock.calls.at(-1)![0];
      expect(lastCall.sampleCount).toBe(5);
      expect(lastCall.averageMs).toBe(1400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit latency for deltas without a preceding appendAudio', () => {
    // Edge: server might send deltas before any audio (warmup ping). Don't crash.
    const onLatency = vi.fn();
    const session = new OpenAISession({
      apiKey: 'sk', sourceLang: 'pt', targetLang: 'en',
      events: { ...events, onLatencyMeasured: onLatency },
      wsFactory: fakeFactory,
    });
    session.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage({ type: 'session.output_audio.delta', delta: 'unsolicited' });
    expect(onLatency).not.toHaveBeenCalled();
  });

  // ---------- M6 (U7): optional input transcription ----------

  describe('input transcription option', () => {
    const todayFrame = (voice?: string) => ({
      type: 'session.update',
      session: { audio: { output: { language: 'en', ...(voice ? { voice } : {}) } } },
    });

    it('without the option: one language update, then the voice in its own update', () => {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        voice: 'cedar',
        events,
        wsFactory: fakeFactory,
      });
      session.start();
      const ws = FakeWebSocket.instances[0]!;
      ws.simulateOpen();
      expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
        todayFrame(),
        todayFrame('cedar'),
      ]);
    });

    it('without a voice, exactly one session.update (as before)', () => {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events,
        wsFactory: fakeFactory,
      });
      session.start();
      const ws = FakeWebSocket.instances[0]!;
      ws.simulateOpen();
      expect(ws.sent.map((s) => JSON.parse(s))).toEqual([todayFrame()]);
    });

    it('with the option, first frame equals today and the second requests transcription', () => {
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        voice: 'cedar',
        events,
        wsFactory: fakeFactory,
        inputTranscriptionModel: 'gpt-realtime-whisper',
      });
      session.start();
      const ws = FakeWebSocket.instances[0]!;
      ws.simulateOpen();
      expect(ws.sent).toHaveLength(3);
      const first = JSON.parse(ws.sent[0]!);
      const second = JSON.parse(ws.sent[1]!);
      expect(first).toEqual(todayFrame());
      expect(second.type).toBe('session.update');
      expect(second.session.audio.input.transcription.model).toBe('gpt-realtime-whisper');
      expect(second.session.audio.output).toEqual(first.session.audio.output);
      expect(JSON.parse(ws.sent[2]!)).toEqual(todayFrame('cedar'));
    });

    it('a rejected voice is ignored: no state change, not resent after a reconnect', () => {
      vi.useFakeTimers();
      try {
        const onState = vi.fn();
        const session = new OpenAISession({
          apiKey: 'sk',
          sourceLang: 'pt',
          targetLang: 'en',
          voice: 'cedar',
          events: { ...events, onState },
          wsFactory: fakeFactory,
        });
        session.start();
        const ws = FakeWebSocket.instances[0]!;
        ws.simulateOpen();
        onState.mockClear();
        ws.simulateMessage({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            param: 'session.audio.output.voice',
            message: 'Unknown parameter',
          },
        });
        expect(onState).not.toHaveBeenCalled();
        ws.close(1006, 'drop');
        vi.advanceTimersByTime(60_000);
        const ws2 = FakeWebSocket.instances[1]!;
        ws2.simulateOpen();
        expect(ws2.sent.map((s) => JSON.parse(s))).toEqual([todayFrame()]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a transcription rejection fires the callback once, keeps the backoff reset, and is latched across reconnects', () => {
      vi.useFakeTimers();
      try {
        const logger = fakeLogger();
        const onRejected = vi.fn();
        const session = new OpenAISession({
          apiKey: 'sk',
          sourceLang: 'pt',
          targetLang: 'en',
          events: { ...events, onInputTranscriptionRejected: onRejected },
          wsFactory: fakeFactory,
          backoff: { baseMs: 10, maxMs: 100, maxAttempts: 5 },
          logger,
          inputTranscriptionModel: 'gpt-realtime-whisper',
        });
        session.start();
        const ws1 = FakeWebSocket.instances[0]!;
        ws1.simulateOpen();
        onState.mockClear();
        const rejection = {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: 'unknown_parameter',
            param: 'session.audio.input.transcription',
            message: 'Unknown parameter: secret detail',
          },
        };
        ws1.simulateMessage(rejection);
        expect(onRejected).toHaveBeenCalledTimes(1);
        expect(onState).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith('input_transcription_rejected', {
          code: 'unknown_parameter',
          param: 'session.audio.input.transcription',
        });
        // The message never reaches the logger.
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret detail');

        // Drop → reconnect: the rejection did not count as a pending server error, so the
        // successful reopen resets the backoff (next drop starts again at attempt 1).
        ws1.close(1006, '');
        expect(onState).toHaveBeenLastCalledWith({ kind: 'reconnecting', attempt: 1 });
        vi.advanceTimersByTime(10);
        const ws2 = FakeWebSocket.instances[1]!;
        ws2.simulateOpen();
        // Latched: only the translation update is sent after the reconnect.
        expect(ws2.sent.map((s) => JSON.parse(s))).toEqual([todayFrame()]);
        ws2.close(1006, '');
        expect(onState).toHaveBeenLastCalledWith({ kind: 'reconnecting', attempt: 1 });
        expect(onRejected).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('an unrelated error is handled as today even with the option set', () => {
      vi.useFakeTimers();
      try {
        const logger = fakeLogger();
        const onRejected = vi.fn();
        const session = new OpenAISession({
          apiKey: 'sk',
          sourceLang: 'pt',
          targetLang: 'en',
          events: { ...events, onInputTranscriptionRejected: onRejected },
          wsFactory: fakeFactory,
          backoff: { baseMs: 10, maxMs: 100, maxAttempts: 1 },
          logger,
          inputTranscriptionModel: 'gpt-realtime-whisper',
        });
        session.start();
        const ws1 = FakeWebSocket.instances[0]!;
        ws1.simulateOpen();
        ws1.simulateMessage({
          type: 'error',
          error: { type: 'server_error', code: 'insufficient_quota', message: 'quota' },
        });
        expect(onRejected).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith('server_error_event', {
          code: 'insufficient_quota',
          type: 'server_error',
          message: 'quota',
        });
        ws1.close(1006, '');
        vi.advanceTimersByTime(10);
        const ws2 = FakeWebSocket.instances[1]!;
        ws2.simulateOpen();
        // Not latched: the transcription update is still requested after the reconnect.
        expect(ws2.sent).toHaveLength(2);
        ws2.close(1006, '');
        expect(onState).toHaveBeenLastCalledWith({
          kind: 'error',
          message: 'reconnect attempts exhausted: quota',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('a transcription-looking error without the option is handled as a normal server error', () => {
      const logger = fakeLogger();
      const onRejected = vi.fn();
      const session = new OpenAISession({
        apiKey: 'sk',
        sourceLang: 'pt',
        targetLang: 'en',
        events: { ...events, onInputTranscriptionRejected: onRejected },
        wsFactory: fakeFactory,
        logger,
      });
      session.start();
      const ws = FakeWebSocket.instances[0]!;
      ws.simulateOpen();
      ws.simulateMessage({
        type: 'error',
        error: { code: 'x', param: 'session.audio.input.transcription', message: 'm' },
      });
      expect(onRejected).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('server_error_event', expect.anything());
    });
  });
});
