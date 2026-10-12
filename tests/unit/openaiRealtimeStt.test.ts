import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  COMMIT_IDLE_MS,
  MAX_SEGMENT_MS,
  OpenAiRealtimeStt,
  createOpenAiSttFactory,
  type OpenAiRealtimeSttConfig,
} from '@main/stt/openaiRealtimeStt';
import type { WebSocketFactory, WebSocketLike } from '@main/translate/openaiSession';
import type { SttSegment, SttTarget } from '@main/stt/sttTypes';
import type { AssistantErrorCode } from '@shared/assistant';

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;
  onopen?: () => void;
  onclose?: (code: number, reason: string) => void;
  onmessage?: (data: string) => void;
  onerror?: (err: Error) => void;

  constructor(
    public url: string,
    public headers: Record<string, string>,
  ) {
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
  frames(): Array<{ type: string; [k: string]: unknown }> {
    return this.sent.map((s) => JSON.parse(s) as { type: string });
  }
  types(): string[] {
    return this.frames().map((f) => f.type);
  }
}

const fakeFactory: WebSocketFactory = (url, headers) => new FakeWebSocket(url, headers);

const fakeLogger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** Base64 of `ms` of PCM16 mono at 24 kHz (48 bytes per ms). */
const pcm = (ms: number): string => Buffer.alloc(ms * 48).toString('base64');

const targetA: SttTarget = { streamId: 'pass-A', direction: 'A', lang: 'it' };
const targetB: SttTarget = { streamId: 'pass-B', direction: 'B', lang: 'en' };

function make(over: Partial<OpenAiRealtimeSttConfig> = {}) {
  const segments: SttSegment[] = [];
  const errors: AssistantErrorCode[] = [];
  const logger = fakeLogger();
  const stt = new OpenAiRealtimeStt({
    apiKey: 'sk-test',
    model: 'gpt-4o-mini-transcribe',
    target: targetA,
    wsFactory: fakeFactory,
    onSegment: (s) => segments.push(s),
    onError: (c) => errors.push(c),
    logger,
    ...over,
  });
  return { stt, segments, errors, logger };
}

const ws = (i = 0): FakeWebSocket => FakeWebSocket.instances[i]!;
const last = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

describe('OpenAiRealtimeStt', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it('opens the transcription URL with the bearer key and sends session.update on open', () => {
    const { stt, logger } = make();
    stt.start();
    expect(ws().url).toBe('wss://api.openai.com/v1/realtime?intent=transcription');
    expect(ws().headers).toEqual({ Authorization: 'Bearer sk-test' });
    expect(ws().sent).toHaveLength(0);
    ws().simulateOpen();
    const [update] = ws().frames();
    expect(update).toMatchObject({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'it' },
            noise_reduction: { type: 'near_field' },
          },
        },
      },
    });
    expect(logger.info).toHaveBeenCalledWith('stt_session_open', {
      streamId: 'pass-A',
      model: 'gpt-4o-mini-transcribe',
    });
  });

  it('direction B sends noise_reduction null', () => {
    const { stt } = make({ target: targetB });
    stt.start();
    ws().simulateOpen();
    const update = ws().frames()[0] as unknown as {
      session: { audio: { input: { noise_reduction: unknown } } };
    };
    expect(update.session.audio.input.noise_reduction).toBeNull();
  });

  it('sends each PCM chunk as input_audio_buffer.append', () => {
    const { stt } = make();
    stt.start();
    ws().simulateOpen();
    const chunk = pcm(40);
    stt.appendPcm(chunk);
    expect(ws().frames()[1]).toEqual({ type: 'input_audio_buffer.append', audio: chunk });
  });

  it('commits after 350 ms idle only when at least 200 ms was appended', () => {
    vi.useFakeTimers();
    try {
      const { stt } = make();
      stt.start();
      ws().simulateOpen();
      // 160 ms of audio: below MIN_COMMIT_MS → no commit on idle.
      for (let i = 0; i < 4; i++) stt.appendPcm(pcm(40));
      vi.advanceTimersByTime(COMMIT_IDLE_MS + 10);
      expect(ws().types()).not.toContain('input_audio_buffer.commit');
      // 2 more chunks → 240 ms total, idle timer restarts on each chunk.
      stt.appendPcm(pcm(40));
      vi.advanceTimersByTime(COMMIT_IDLE_MS - 50);
      stt.appendPcm(pcm(40));
      vi.advanceTimersByTime(COMMIT_IDLE_MS - 1);
      expect(ws().types()).not.toContain('input_audio_buffer.commit');
      vi.advanceTimersByTime(1);
      expect(
        ws()
          .types()
          .filter((t) => t === 'input_audio_buffer.commit'),
      ).toHaveLength(1);
      expect(ws().frames().at(-1)).toEqual({ type: 'input_audio_buffer.commit' });
      // Counter reset after commit: a lone 40 ms chunk does not commit again.
      stt.appendPcm(pcm(40));
      vi.advanceTimersByTime(COMMIT_IDLE_MS + 10);
      expect(
        ws()
          .types()
          .filter((t) => t === 'input_audio_buffer.commit'),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forces a commit at 15 s of uncommitted audio without waiting for idle', () => {
    vi.useFakeTimers();
    try {
      const { stt } = make();
      stt.start();
      ws().simulateOpen();
      const chunks = MAX_SEGMENT_MS / 40;
      for (let i = 0; i < chunks - 1; i++) stt.appendPcm(pcm(40));
      expect(ws().types()).not.toContain('input_audio_buffer.commit');
      stt.appendPcm(pcm(40));
      expect(ws().frames().at(-1)).toEqual({ type: 'input_audio_buffer.commit' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues PCM before open (cap 100, oldest dropped) and flushes after the update', () => {
    const { stt } = make();
    stt.start();
    const chunks = Array.from({ length: 105 }, (_, i) =>
      Buffer.from(`chunk-${i}-pad`).toString('base64'),
    );
    for (const c of chunks) stt.appendPcm(c);
    ws().simulateOpen();
    const frames = ws().frames();
    expect(frames[0]!.type).toBe('session.update');
    const appended = frames.slice(1).map((f) => f.audio);
    expect(appended).toHaveLength(100);
    expect(appended[0]).toBe(chunks[5]);
    expect(appended[99]).toBe(chunks[104]);
  });

  it('reconnects with backoff on close, dropping PCM queued before the drop', () => {
    vi.useFakeTimers();
    try {
      const { stt, errors } = make();
      stt.start();
      ws(0).simulateOpen();
      ws(0).close(1006, 'net');
      expect(FakeWebSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(999);
      expect(FakeWebSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(2);
      ws(1).simulateOpen();
      expect(ws(1).types()).toEqual(['session.update']);
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports stt-failed when reconnects are exhausted', () => {
    vi.useFakeTimers();
    try {
      const { stt, errors } = make({ backoff: { baseMs: 10, maxMs: 10, maxAttempts: 2 } });
      stt.start();
      ws(0).close(1006, '');
      vi.advanceTimersByTime(10);
      last().close(1006, '');
      vi.advanceTimersByTime(10);
      last().close(1006, '');
      expect(FakeWebSocket.instances).toHaveLength(3);
      expect(errors).toEqual(['stt-failed']);
      vi.advanceTimersByTime(1000);
      expect(FakeWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets backoff after a successful reopen: 7 open-then-close cycles never exhaust', () => {
    vi.useFakeTimers();
    try {
      const { stt, errors } = make();
      stt.start();
      for (let i = 0; i < 7; i++) {
        last().simulateOpen();
        last().close(1006, 'expired');
        // Always the first backoff step (1 s) because the counter reset on open.
        vi.advanceTimersByTime(1000);
        expect(FakeWebSocket.instances).toHaveLength(i + 2);
      }
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('session_expired is not fatal: the server close reconnects and the budget resets', () => {
    vi.useFakeTimers();
    try {
      const { stt, errors } = make();
      stt.start();
      for (let i = 0; i < 7; i++) {
        last().simulateOpen();
        last().simulateMessage({
          type: 'error',
          error: { type: 'invalid_request_error', code: 'session_expired' },
        });
        last().close(1000, 'expired');
        vi.advanceTimersByTime(1000);
        expect(FakeWebSocket.instances).toHaveLength(i + 2);
      }
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-fatal error then close on every socket does not reset backoff and exhausts', () => {
    vi.useFakeTimers();
    try {
      const { stt, errors } = make({ backoff: { baseMs: 10, maxMs: 10, maxAttempts: 2 } });
      stt.start();
      for (let i = 0; i < 3; i++) {
        last().simulateOpen();
        last().simulateMessage({
          type: 'error',
          error: { type: 'insufficient_quota', code: 'insufficient_quota' },
        });
        last().close(1011, '');
        vi.advanceTimersByTime(10);
      }
      expect(errors).toEqual(['stt-failed']);
      expect(FakeWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fatal server error closes, does not reconnect and reports stt-failed', () => {
    vi.useFakeTimers();
    try {
      const { stt, errors, logger } = make();
      stt.start();
      ws().simulateOpen();
      ws().simulateMessage({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'unknown_parameter',
          param: 'session.audio.input.turn_detection',
          message: 'secret-ish text',
        },
      });
      expect(ws().closed).toBe(true);
      expect(errors).toEqual(['stt-failed']);
      expect(logger.warn).toHaveBeenCalledWith('stt_session_rejected', {
        code: 'unknown_parameter',
        param: 'session.audio.input.turn_detection',
      });
      for (const call of logger.warn.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('secret-ish');
      }
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      stt.appendPcm(pcm(40));
      expect(ws().types()).toEqual(['session.update']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-fatal server error is logged and the session continues', () => {
    const { stt, errors, logger } = make();
    stt.start();
    ws().simulateOpen();
    ws().simulateMessage({ type: 'error', error: { type: 'server_error', code: 'x' } });
    expect(errors).toEqual([]);
    expect(ws().closed).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('stt_server_error', {
      code: 'x',
      type: 'server_error',
      param: 'unknown',
    });
  });

  it('a 401 handshake rejection is fatal (no reconnect)', () => {
    vi.useFakeTimers();
    try {
      const { stt, errors } = make();
      stt.start();
      ws().simulateError(new Error('Unexpected server response: 401'));
      expect(errors).toEqual(['stt-failed']);
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps delta / completed / failed events to segments', () => {
    const { stt, segments, logger } = make({ target: targetB });
    stt.start();
    ws().simulateOpen();
    ws().simulateMessage({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item_1',
      delta: 'Hel',
    });
    ws().simulateMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item_1',
      transcript: 'Hello.',
    });
    ws().simulateMessage({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'item_2',
    });
    expect(segments).toEqual([
      { id: 'pass-B-item_1', direction: 'B', text: 'Hel', final: false, mode: 'append' },
      { id: 'pass-B-item_1', direction: 'B', text: 'Hello.', final: true, mode: 'replace' },
      { id: 'pass-B-item_2', direction: 'B', text: '', final: true, mode: 'append' },
    ]);
    expect(logger.warn).toHaveBeenCalledWith('stt_item_failed', { streamId: 'pass-B' });
  });

  it('caps segment ids at 80 characters', () => {
    const { stt, segments } = make();
    stt.start();
    ws().simulateOpen();
    ws().simulateMessage({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'x'.repeat(200),
      delta: 'a',
    });
    expect(segments[0]!.id).toHaveLength(80);
    expect(segments[0]!.id.startsWith('pass-A-xxx')).toBe(true);
  });

  it('stop() closes, cancels a pending reconnect and ignores late frames', () => {
    vi.useFakeTimers();
    try {
      const { stt, segments } = make();
      stt.start();
      ws().simulateOpen();
      ws().close(1006, '');
      stt.stop();
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      ws().simulateMessage({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'i',
        delta: 'late',
      });
      expect(segments).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never logs transcript text', () => {
    const { stt, logger } = make();
    stt.start();
    ws().simulateOpen();
    ws().simulateMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i',
      transcript: 'PRIVATE WORDS',
    });
    for (const fn of [logger.debug, logger.info, logger.warn, logger.error]) {
      for (const call of fn.mock.calls) expect(JSON.stringify(call)).not.toContain('PRIVATE');
    }
  });
});

describe('createOpenAiSttFactory', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it('without a key reports no-openai-key and returns a no-op instance; nothing connects', () => {
    const factory = createOpenAiSttFactory({
      apiKey: () => undefined,
      model: () => 'gpt-4o-mini-transcribe',
      wsFactory: fakeFactory,
    });
    const errors: AssistantErrorCode[] = [];
    const inst = factory.create(
      targetA,
      () => {},
      (c) => errors.push(c),
    );
    expect(errors).toEqual(['no-openai-key']);
    expect(inst.appendPcm).toBeUndefined();
    expect(() => inst.stop()).not.toThrow();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('with a key starts a session using the current model', () => {
    const factory = createOpenAiSttFactory({
      apiKey: () => 'sk-k',
      model: () => 'gpt-4o-transcribe',
      wsFactory: fakeFactory,
    });
    const inst = factory.create(
      targetA,
      () => {},
      () => {},
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws().headers.Authorization).toBe('Bearer sk-k');
    ws().simulateOpen();
    expect(ws().frames()[0]).toMatchObject({
      session: { audio: { input: { transcription: { model: 'gpt-4o-transcribe' } } } },
    });
    expect(typeof inst.appendPcm).toBe('function');
    inst.stop();
    expect(ws().closed).toBe(true);
  });
});
