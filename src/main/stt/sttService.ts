/**
 * Converges "which passthrough streams are transcribed with which engine" into running
 * engine instances and offscreen taps (spec §6.2). No Electron imports.
 */
import type { AssistantErrorCode, SttEngine, SttStatus } from '../../shared/assistant';
import type { Direction } from '../../shared/types';
import type { Logger } from '../util/logger';
import {
  TAP_MODE_FOR_ENGINE,
  type ActiveSttEngine,
  type SttEngineFactory,
  type SttEngineInstance,
  type SttSegment,
  type SttTapController,
  type SttTarget,
} from './sttTypes';

export interface SttServiceDeps {
  engines: Record<ActiveSttEngine, SttEngineFactory>;
  tap: SttTapController;
  models: () => Record<ActiveSttEngine, string>;
  onSegment: (s: SttSegment) => void;
  onStatus: (s: SttStatus) => void;
  now: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  logger?: Logger;
}

interface Running {
  key: string;
  direction: Direction;
  /** Undefined only while the factory's create() runs. */
  instance: SttEngineInstance | undefined;
  errorCode?: AssistantErrorCode;
}

interface Wanted {
  target: SttTarget;
  engine: ActiveSttEngine;
  model: string;
  key: string;
}

const DIRECTION_ORDER: readonly Direction[] = ['A', 'B'];

export class SttService {
  private readonly running = new Map<string, Running>();
  private chain: Promise<void> = Promise.resolve();
  private last: { engine: SttEngine; targets: SttTarget[] } = { engine: 'off', targets: [] };
  /** Engine of the last applied sync (status.engine). */
  private engine: SttEngine = 'off';
  /** Error not tied to a running instance (setTap failure). */
  private serviceError: AssistantErrorCode | undefined;
  private lastEmitted: string;

  constructor(private readonly deps: SttServiceDeps) {
    this.lastEmitted = JSON.stringify(this.status());
  }

  sync(engine: SttEngine, targets: SttTarget[]): Promise<void> {
    this.last = { engine, targets: targets.map((t) => ({ ...t })) };
    return this.enqueue(() => this.apply(engine, targets));
  }

  /** Clears the error, stops every instance, then re-runs the last sync. */
  retry(): Promise<void> {
    return this.enqueue(async () => {
      this.serviceError = undefined;
      await this.stopEverything();
      // M7: reload the local model here when the engine is 'local'.
      const { engine, targets } = this.last;
      await this.apply(engine, targets);
    });
  }

  stopAll(): Promise<void> {
    return this.enqueue(async () => {
      this.serviceError = undefined;
      await this.stopEverything();
    });
  }

  status(): SttStatus {
    const streams = DIRECTION_ORDER.filter((d) =>
      [...this.running.values()].some((r) => r.direction === d),
    );
    let errorCode = this.serviceError;
    for (const r of this.running.values()) {
      if (errorCode === undefined && r.errorCode !== undefined) errorCode = r.errorCode;
    }
    const state: SttStatus['state'] =
      errorCode !== undefined ? 'error' : this.running.size === 0 ? 'off' : 'listening';
    return {
      engine: this.engine,
      state,
      streams,
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
  }

  // -------------------------------------------------------------------------

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn).catch((err: unknown) => {
      this.deps.logger?.error('stt_sync_failed', {
        reason: err instanceof Error ? err.name : 'unknown',
      });
    });
    this.chain = next;
    return next.finally(() => this.emitIfChanged());
  }

  private async apply(engine: SttEngine, targets: SttTarget[]): Promise<void> {
    this.engine = engine;
    const wanted = new Map<string, Wanted>();
    if (engine !== 'off') {
      const model = this.deps.models()[engine];
      for (const target of targets) {
        wanted.set(target.streamId, {
          target,
          engine,
          model,
          key: `${target.streamId}|${engine}|${model}|${target.lang}`,
        });
      }
    }

    const toStop = [...this.running.entries()]
      .filter(([id, r]) => wanted.get(id)?.key !== r.key)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const toStart = [...wanted.values()].filter(
      (w) => this.running.get(w.target.streamId)?.key !== w.key,
    );
    if (toStop.length === 0 && toStart.length === 0) return;
    // A reconfiguration supersedes an earlier tap failure; it is set again if it recurs.
    this.serviceError = undefined;

    for (const [id, r] of toStop) await this.stopOne(id, r);
    for (const w of toStart) await this.startOne(w);
  }

  private async startOne(w: Wanted): Promise<void> {
    const { streamId } = w.target;
    const rec: Running = { key: w.key, direction: w.target.direction, instance: undefined };
    this.running.set(streamId, rec);
    const current = (): boolean => this.running.get(streamId) === rec;
    const instance = this.deps.engines[w.engine].create(
      w.target,
      (s) => {
        if (current()) this.deps.onSegment(s);
      },
      (code) => {
        if (!current()) return;
        rec.errorCode = code;
        this.deps.logger?.warn('stt_engine_error', { streamId, code });
        this.emitIfChanged();
      },
    );
    rec.instance = instance;
    if (!current()) {
      instance.stop();
      return;
    }
    if (!instance.appendPcm) {
      // A no-op instance (e.g. no API key): keep the record for its error status but leave
      // the tap off, so the offscreen page does not resample and IPC-send PCM nobody reads.
      this.deps.logger?.info('stt_stream_idle', { streamId, engine: w.engine });
      return;
    }
    try {
      await this.deps.tap.setTap(
        streamId,
        TAP_MODE_FOR_ENGINE[w.engine],
        { model: w.model, lang: w.target.lang },
        instance.appendPcm?.bind(instance),
      );
    } catch {
      instance.stop();
      if (current()) this.running.delete(streamId);
      this.deps.logger?.warn('stt_tap_failed', { streamId });
      this.serviceError = 'stt-failed';
      return;
    }
    this.deps.logger?.info('stt_stream_started', { streamId, engine: w.engine });
  }

  private async stopOne(streamId: string, r: Running): Promise<void> {
    if (this.running.get(streamId) === r) this.running.delete(streamId);
    try {
      await this.deps.tap.setTap(streamId, 'off');
    } catch {
      this.deps.logger?.warn('stt_tap_off_failed', { streamId });
    }
    r.instance?.stop();
    this.deps.logger?.info('stt_stream_stopped', { streamId });
  }

  private async stopEverything(): Promise<void> {
    const all = [...this.running.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [id, r] of all) await this.stopOne(id, r);
  }

  private emitIfChanged(): void {
    const s = this.status();
    const json = JSON.stringify(s);
    if (json === this.lastEmitted) return;
    this.lastEmitted = json;
    this.deps.onStatus(s);
  }
}
