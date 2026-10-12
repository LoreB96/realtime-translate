import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SessionManager,
  type SessionManagerConfig,
} from '@main/translate/sessionManager';
import type { OffscreenController } from '@main/translate/audioPipeline';
import type { Direction, SessionState } from '@shared/types';
import type { WebSocketLike, WebSocketFactory } from '@main/translate/openaiSession';

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
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
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  simulateError(err: Error): void {
    this.onerror?.(err);
  }
}

class FakeOffscreen implements OffscreenController {
  startCaptureCalled = new Map<string, string>();
  startPlaybackCalled = new Map<string, string>();
  pushedAudio = new Map<string, string[]>();
  pcmCallbacks = new Map<string, (b64: string) => void>();
  stoppedStreams = new Set<string>();
  stoppedAll = false;

  async startCapture(
    streamId: string,
    deviceId: string,
    onPcm: (b64: string) => void,
  ): Promise<void> {
    this.startCaptureCalled.set(streamId, deviceId);
    this.pcmCallbacks.set(streamId, onPcm);
  }
  async startPlayback(streamId: string, deviceId: string): Promise<void> {
    this.startPlaybackCalled.set(streamId, deviceId);
  }
  pushPlayback(streamId: string, b64: string): void {
    const list = this.pushedAudio.get(streamId) ?? [];
    list.push(b64);
    this.pushedAudio.set(streamId, list);
  }
  stopStream(streamId: string): void {
    // Mirror production OffscreenBridge.stopStream — clear per-stream callback so
    // the fake doesn't drift from real behavior in a future test that asserts post-stop
    // state (e.g., reconnect tests in M3+).
    this.stoppedStreams.add(streamId);
    this.pcmCallbacks.delete(streamId);
  }
  stopAll(): void {
    this.stoppedAll = true;
  }
}

describe('SessionManager', () => {
  let offscreen: FakeOffscreen;
  let onState: ReturnType<typeof vi.fn>;
  let onTranscript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    offscreen = new FakeOffscreen();
    onState = vi.fn();
    onTranscript = vi.fn();
  });

  const buildConfig = (overrides: Partial<SessionManagerConfig> = {}): SessionManagerConfig => {
    const wsFactory: WebSocketFactory = (url, headers) => new FakeWebSocket(url, headers);
    return {
      apiKey: 'sk-test',
      sourceLang: 'pt',
      targetLang: 'en',
      micDeviceId: 'mic',
      toMeetDeviceId: 'cableA-input',
      fromMeetDeviceId: 'cableB-output',
      headsetDeviceId: 'headset',
      offscreen,
      wsFactory,
      onDirectionalState: onState as (s: { direction: Direction; state: SessionState }) => void,
      onTranscript: onTranscript as (t: {
        direction: Direction;
        kind: 'input' | 'output';
        text: string;
      }) => void,
      onLatencyMeasured: vi.fn(),
      ...overrides,
    };
  };

  it('start() opens both sessions and configures both pipelines', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    // 2 sockets opened
    expect(FakeWebSocket.instances).toHaveLength(2);
    // streams A and B are configured
    expect(offscreen.startCaptureCalled.get('A')).toBe('mic');
    expect(offscreen.startPlaybackCalled.get('A')).toBe('cableA-input');
    expect(offscreen.startCaptureCalled.get('B')).toBe('cableB-output');
    expect(offscreen.startPlaybackCalled.get('B')).toBe('headset');
  });

  it('emits per-direction state transitions', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    expect(onState).toHaveBeenCalledWith({ direction: 'A', state: { kind: 'connecting' } });
    expect(onState).toHaveBeenCalledWith({ direction: 'B', state: { kind: 'connecting' } });
    FakeWebSocket.instances[0]!.simulateOpen();
    FakeWebSocket.instances[1]!.simulateOpen();
    const lastA = onState.mock.calls
      .map((c) => c[0])
      .filter((s) => (s as { direction: Direction }).direction === 'A')
      .pop();
    expect((lastA as { state: SessionState }).state.kind).toBe('active');
  });

  it('routes session A audio deltas to stream A playback', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    const wsA = FakeWebSocket.instances[0]!;
    wsA.simulateOpen();
    // Server sends audio delta to A
    wsA.onmessage?.(JSON.stringify({ type: 'session.output_audio.delta', delta: 'a-out' }));
    expect(offscreen.pushedAudio.get('A')).toEqual(['a-out']);
    expect(offscreen.pushedAudio.get('B') ?? []).toEqual([]);
    void mgr;
  });

  it('routes session B audio deltas to stream B playback', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    const wsB = FakeWebSocket.instances[1]!;
    wsB.simulateOpen();
    wsB.onmessage?.(JSON.stringify({ type: 'session.output_audio.delta', delta: 'b-out' }));
    expect(offscreen.pushedAudio.get('B')).toEqual(['b-out']);
    expect(offscreen.pushedAudio.get('A') ?? []).toEqual([]);
    void mgr;
  });

  it('one direction failing does not stop the other (degraded mode)', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    const wsA = FakeWebSocket.instances[0]!;
    const wsB = FakeWebSocket.instances[1]!;
    wsA.simulateOpen();
    wsB.simulateOpen();
    // Fatal failure on A (e.g. key revoked mid-call → reconnect rejected with 401).
    wsA.simulateError(new Error('Unexpected server response: 401'));
    wsA.close(1006, '');
    // Last emitted A state is error; B state is still active
    const aStates = onState.mock.calls
      .map((c) => c[0])
      .filter((s) => (s as { direction: Direction }).direction === 'A');
    expect((aStates[aStates.length - 1] as { state: SessionState }).state.kind).toBe('error');
    const bStates = onState.mock.calls
      .map((c) => c[0])
      .filter((s) => (s as { direction: Direction }).direction === 'B');
    expect((bStates[bStates.length - 1] as { state: SessionState }).state.kind).toBe('active');
  });

  it('stop() tears down both sessions and both streams', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    FakeWebSocket.instances[0]!.simulateOpen();
    FakeWebSocket.instances[1]!.simulateOpen();
    await mgr.stop();
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
    expect(FakeWebSocket.instances[1]!.closed).toBe(true);
    expect(offscreen.stoppedStreams.has('A')).toBe(true);
    expect(offscreen.stoppedStreams.has('B')).toBe(true);
  });

  it('start() throws and emits error on direction A if pipeline A startCapture fails', async () => {
    class FailingOffscreenA extends FakeOffscreen {
      override async startCapture(
        streamId: string,
        deviceId: string,
        onPcm: (b64: string) => void,
      ): Promise<void> {
        if (streamId === 'A') throw new Error('A capture failed');
        return super.startCapture(streamId, deviceId, onPcm);
      }
    }
    const offA = new FailingOffscreenA();
    const mgr = new SessionManager(buildConfig({ offscreen: offA }));
    await expect(mgr.start()).rejects.toThrow();
    const aStates = onState.mock.calls
      .map((c) => c[0])
      .filter((s) => (s as { direction: Direction }).direction === 'A');
    expect((aStates[aStates.length - 1] as { state: SessionState }).state).toEqual({
      kind: 'error',
      message: 'A capture failed',
    });
  });

  it('start() failure tears down the surviving direction and keeps the real error last', async () => {
    class FailingOffscreenB extends FakeOffscreen {
      override async startCapture(
        streamId: string,
        deviceId: string,
        onPcm: (b64: string) => void,
      ): Promise<void> {
        if (streamId === 'B') throw new Error('B capture failed');
        return super.startCapture(streamId, deviceId, onPcm);
      }
    }
    const offB = new FailingOffscreenB();
    const mgr = new SessionManager(buildConfig({ offscreen: offB }));
    await expect(mgr.start()).rejects.toThrow('B capture failed');
    // A's socket was opened and must be closed, not left running unreferenced.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
    expect(offB.stoppedStreams.has('A')).toBe(true);
    const last = onState.mock.calls[onState.mock.calls.length - 1]![0];
    expect(last).toEqual({ direction: 'B', state: { kind: 'error', message: 'B capture failed' } });
    // Caller's defensive stop() is a no-op.
    await expect(mgr.stop()).resolves.toBeUndefined();
  });

  it('reports the failing device side on start', async () => {
    class FailingPlaybackA extends FakeOffscreen {
      override async startPlayback(streamId: string, deviceId: string): Promise<void> {
        if (streamId === 'A') throw new Error('setSinkId failed');
        return super.startPlayback(streamId, deviceId);
      }
    }
    const onDeviceFailure = vi.fn();
    const mgr = new SessionManager(
      buildConfig({ offscreen: new FailingPlaybackA(), onDeviceFailure }),
    );
    await expect(mgr.start()).rejects.toThrow('setSinkId failed');
    expect(onDeviceFailure).toHaveBeenCalledWith({
      direction: 'A',
      side: 'output',
      message: 'setSinkId failed',
    });
    const aStates = onState.mock.calls
      .map((c) => c[0])
      .filter((s) => (s as { direction: Direction }).direction === 'A');
    expect((aStates[aStates.length - 1] as { state: SessionState }).state).toEqual({
      kind: 'error',
      message: 'setSinkId failed',
    });
  });

  it('restartAudio() re-opens one direction and keeps both sockets open', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    FakeWebSocket.instances[0]!.simulateOpen();
    FakeWebSocket.instances[1]!.simulateOpen();
    offscreen.startCaptureCalled.clear();
    offscreen.startPlaybackCalled.clear();
    await mgr.restartAudio('B');
    expect(offscreen.startCaptureCalled.get('B')).toBe('cableB-output');
    expect(offscreen.startPlaybackCalled.get('B')).toBe('headset');
    expect(offscreen.startCaptureCalled.has('A')).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances.every((ws) => !ws.closed)).toBe(true);
    await mgr.stop();
  });

  it('restartAudio() reports device failures and rejects when not running', async () => {
    let failB = false;
    class Flaky extends FakeOffscreen {
      override async startCapture(
        streamId: string,
        deviceId: string,
        onPcm: (b64: string) => void,
      ): Promise<void> {
        if (failB && streamId === 'B') throw new Error('Requested device not found');
        return super.startCapture(streamId, deviceId, onPcm);
      }
    }
    const onDeviceFailure = vi.fn();
    const mgr = new SessionManager(buildConfig({ offscreen: new Flaky(), onDeviceFailure }));
    await expect(mgr.restartAudio('A')).rejects.toThrow('not running');
    await mgr.start();
    failB = true;
    await expect(mgr.restartAudio('B')).rejects.toThrow('Requested device not found');
    expect(onDeviceFailure).toHaveBeenCalledWith({
      direction: 'B',
      side: 'input',
      message: 'Requested device not found',
    });
    await mgr.stop();
  });

  it('routes session A input transcript deltas to onTranscript with direction A', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    const wsA = FakeWebSocket.instances[0]!;
    wsA.simulateOpen();
    wsA.onmessage?.(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'olá' }));
    expect(onTranscript).toHaveBeenCalledWith({ direction: 'A', kind: 'input', text: 'olá' });
    void mgr;
  });

  it('without the input transcription option, each session sends exactly one update', async () => {
    const mgr = new SessionManager(buildConfig());
    await mgr.start();
    for (const ws of FakeWebSocket.instances) {
      ws.simulateOpen();
      expect(ws.sent).toHaveLength(1);
    }
    void mgr;
  });

  it('passes the input transcription model and rejection callback to both sessions', async () => {
    const onRejected = vi.fn();
    const mgr = new SessionManager(
      buildConfig({
        inputTranscriptionModel: 'gpt-realtime-whisper',
        onInputTranscriptionRejected: onRejected,
      }),
    );
    await mgr.start();
    expect(FakeWebSocket.instances).toHaveLength(2);
    for (const ws of FakeWebSocket.instances) {
      ws.simulateOpen();
      expect(ws.sent).toHaveLength(2);
      const second = JSON.parse(ws.sent[1]!);
      expect(second.session.audio.input.transcription.model).toBe('gpt-realtime-whisper');
    }
    const rejection = JSON.stringify({
      type: 'error',
      error: { code: 'unknown_parameter', param: 'session.audio.input.transcription' },
    });
    FakeWebSocket.instances[1]!.onmessage?.(rejection);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenLastCalledWith('B');
    FakeWebSocket.instances[0]!.onmessage?.(rejection);
    expect(onRejected).toHaveBeenCalledTimes(2);
    expect(onRejected).toHaveBeenLastCalledWith('A');
    void mgr;
  });
});
