import { describe, it, expect, vi } from 'vitest';
import { SttService } from '@main/stt/sttService';
import type {
  SttEngineFactory,
  SttEngineInstance,
  SttSegment,
  SttTapController,
  SttTarget,
} from '@main/stt/sttTypes';
import type { AssistantErrorCode, SttStatus } from '@shared/assistant';
import type { TapMode, TapOptions } from '@shared/offscreenContract';

interface FakeInstance extends SttEngineInstance {
  target: SttTarget;
  stopped: boolean;
  pcm: string[];
  emit: (s: SttSegment) => void;
  fail: (c: AssistantErrorCode) => void;
}

function setup(opts: { noKey?: boolean; failTapFor?: string } = {}) {
  const log: string[] = [];
  const instances: FakeInstance[] = [];
  const segments: SttSegment[] = [];
  const statuses: SttStatus[] = [];
  const taps: Array<{
    streamId: string;
    mode: TapMode;
    opts: TapOptions | undefined;
    onPcm: ((b64: string) => void) | undefined;
  }> = [];
  let model = 'gpt-4o-mini-transcribe';

  const openai: SttEngineFactory = {
    create(target, onSegment, onError) {
      log.push(`create:${target.streamId}:${target.lang}`);
      if (opts.noKey) {
        onError('no-openai-key');
        return { stop: () => log.push(`stop-noop:${target.streamId}`) };
      }
      const inst: FakeInstance = {
        target,
        stopped: false,
        pcm: [],
        emit: onSegment,
        fail: onError,
        stop() {
          this.stopped = true;
          log.push(`stop:${target.streamId}`);
        },
        appendPcm(b64: string) {
          this.pcm.push(b64);
        },
      };
      instances.push(inst);
      return inst;
    },
  };
  const tap: SttTapController = {
    setTap: vi.fn(async (streamId, mode, o, onPcm) => {
      log.push(`tap:${streamId}:${mode}`);
      if (opts.failTapFor === streamId && mode !== 'off') throw new Error('offscreen gone');
      taps.push({ streamId, mode, opts: o, onPcm });
    }),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const svc = new SttService({
    engines: { openai },
    tap,
    models: () => ({ openai: model }),
    onSegment: (s) => segments.push(s),
    onStatus: (s) => statuses.push(s),
    now: () => 0,
    logger,
  });
  return {
    svc,
    log,
    instances,
    segments,
    statuses,
    taps,
    tap,
    logger,
    setModel: (m: string) => {
      model = m;
    },
  };
}

const A: SttTarget = { streamId: 'pass-A', direction: 'A', lang: 'it' };
const B: SttTarget = { streamId: 'pass-B', direction: 'B', lang: 'en' };

describe('SttService', () => {
  it('starts each target: create first, then main24k tap with options and the appendPcm callback', async () => {
    const t = setup();
    await t.svc.sync('openai', [A, B]);
    expect(t.log).toEqual([
      'create:pass-A:it',
      'tap:pass-A:main24k',
      'create:pass-B:en',
      'tap:pass-B:main24k',
    ]);
    expect(t.taps[0]!.opts).toEqual({ model: 'gpt-4o-mini-transcribe', lang: 'it' });
    t.taps[0]!.onPcm!('abc');
    expect(t.instances[0]!.pcm).toEqual(['abc']);
    expect(t.svc.status()).toEqual({ engine: 'openai', state: 'listening', streams: ['A', 'B'] });
  });

  it("engine 'off' stops everything: tap off before stop()", async () => {
    const t = setup();
    await t.svc.sync('openai', [A]);
    t.log.length = 0;
    await t.svc.sync('off', [A]);
    expect(t.log).toEqual(['tap:pass-A:off', 'stop:pass-A']);
    expect(t.svc.status()).toEqual({ engine: 'off', state: 'off', streams: [] });
  });

  it('an unchanged sync is a no-op', async () => {
    const t = setup();
    await t.svc.sync('openai', [A, B]);
    t.log.length = 0;
    const emitted = t.statuses.length;
    await t.svc.sync('openai', [{ ...A }, { ...B }]);
    expect(t.log).toEqual([]);
    expect(t.statuses).toHaveLength(emitted);
  });

  it('removing a target stops only that stream', async () => {
    const t = setup();
    await t.svc.sync('openai', [A, B]);
    t.log.length = 0;
    await t.svc.sync('openai', [B]);
    expect(t.log).toEqual(['tap:pass-A:off', 'stop:pass-A']);
    expect(t.svc.status().streams).toEqual(['B']);
  });

  it('a language or model change restarts the affected stream(s)', async () => {
    const t = setup();
    await t.svc.sync('openai', [A, B]);
    t.log.length = 0;
    await t.svc.sync('openai', [{ ...A, lang: 'fr' }, B]);
    expect(t.log).toEqual([
      'tap:pass-A:off',
      'stop:pass-A',
      'create:pass-A:fr',
      'tap:pass-A:main24k',
    ]);
    t.log.length = 0;
    t.setModel('gpt-4o-transcribe');
    await t.svc.sync('openai', [{ ...A, lang: 'fr' }, B]);
    expect(t.log).toEqual([
      'tap:pass-A:off',
      'stop:pass-A',
      'tap:pass-B:off',
      'stop:pass-B',
      'create:pass-A:fr',
      'tap:pass-A:main24k',
      'create:pass-B:en',
      'tap:pass-B:main24k',
    ]);
    expect(t.taps.at(-1)!.opts).toEqual({ model: 'gpt-4o-transcribe', lang: 'en' });
  });

  it('setTap failure stops the instance and reports stt-failed', async () => {
    const t = setup({ failTapFor: 'pass-B' });
    await t.svc.sync('openai', [A, B]);
    expect(t.instances[1]!.stopped).toBe(true);
    expect(t.logger.warn).toHaveBeenCalledWith('stt_tap_failed', { streamId: 'pass-B' });
    expect(t.svc.status()).toEqual({
      engine: 'openai',
      state: 'error',
      streams: ['A'],
      errorCode: 'stt-failed',
    });
  });

  it('no key: the engine error becomes an error status with no-openai-key', async () => {
    const t = setup({ noKey: true });
    await t.svc.sync('openai', [A]);
    expect(t.svc.status()).toEqual({
      engine: 'openai',
      state: 'error',
      streams: ['A'],
      errorCode: 'no-openai-key',
    });
    expect(t.statuses.at(-1)).toEqual(t.svc.status());
    // No consumer for PCM: the offscreen tap is never enabled.
    expect(t.log).toEqual(['create:pass-A:it']);
    expect(t.taps).toEqual([]);
  });

  it('an engine error after start sets error state; retry clears it and restarts every stream', async () => {
    const t = setup();
    await t.svc.sync('openai', [A, B]);
    t.instances[0]!.fail('stt-failed');
    expect(t.statuses.at(-1)).toMatchObject({ state: 'error', errorCode: 'stt-failed' });
    t.log.length = 0;
    await t.svc.retry();
    expect(t.log).toEqual([
      'tap:pass-A:off',
      'stop:pass-A',
      'tap:pass-B:off',
      'stop:pass-B',
      'create:pass-A:it',
      'tap:pass-A:main24k',
      'create:pass-B:en',
      'tap:pass-B:main24k',
    ]);
    expect(t.svc.status()).toEqual({ engine: 'openai', state: 'listening', streams: ['A', 'B'] });
  });

  it('forwards segments only from current instances', async () => {
    const t = setup();
    await t.svc.sync('openai', [A]);
    const old = t.instances[0]!;
    const seg: SttSegment = {
      id: 'pass-A-1',
      direction: 'A',
      text: 'hi',
      final: false,
      mode: 'append',
    };
    old.emit(seg);
    expect(t.segments).toEqual([seg]);
    await t.svc.sync('openai', [{ ...A, lang: 'de' }]);
    old.emit({ ...seg, text: 'stale' });
    old.fail('stt-failed');
    expect(t.segments).toEqual([seg]);
    expect(t.svc.status().state).toBe('listening');
  });

  it('serializes overlapping calls in order', async () => {
    const t = setup();
    const p1 = t.svc.sync('openai', [A]);
    const p2 = t.svc.sync('off', []);
    const p3 = t.svc.sync('openai', [B]);
    await Promise.all([p1, p2, p3]);
    expect(t.log).toEqual([
      'create:pass-A:it',
      'tap:pass-A:main24k',
      'tap:pass-A:off',
      'stop:pass-A',
      'create:pass-B:en',
      'tap:pass-B:main24k',
    ]);
  });

  it('stopAll stops everything; a later retry re-runs the last sync', async () => {
    const t = setup();
    await t.svc.sync('openai', [A]);
    await t.svc.stopAll();
    expect(t.svc.status()).toEqual({ engine: 'openai', state: 'off', streams: [] });
    t.log.length = 0;
    await t.svc.retry();
    expect(t.log).toEqual(['create:pass-A:it', 'tap:pass-A:main24k']);
  });

  it('emits status only on change', async () => {
    const t = setup();
    expect(t.statuses).toEqual([]);
    await t.svc.sync('off', []);
    expect(t.statuses).toEqual([]);
    await t.svc.sync('openai', [A]);
    await t.svc.sync('openai', [A]);
    expect(t.statuses).toEqual([{ engine: 'openai', state: 'listening', streams: ['A'] }]);
    await t.svc.sync('off', []);
    expect(t.statuses).toHaveLength(2);
    expect(t.statuses[1]).toEqual({ engine: 'off', state: 'off', streams: [] });
  });
});
