import type { OffscreenController } from './audioPipeline';
import { AudioDeviceError, AudioPipeline } from './audioPipeline';
import { OpenAISession, type WebSocketFactory } from './openaiSession';
import type { Direction, SessionState } from '../../shared/types';
import type { LanguageCode } from '../../shared/languages';
import type { Logger } from '../util/logger';

export interface SessionManagerConfig {
  apiKey: string;
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  micDeviceId: string;
  toMeetDeviceId: string;
  fromMeetDeviceId: string;
  headsetDeviceId: string;
  offscreen: OffscreenController;
  wsFactory: WebSocketFactory;
  onDirectionalState: (s: { direction: Direction; state: SessionState }) => void;
  onTranscript: (t: { direction: Direction; kind: 'input' | 'output'; text: string }) => void;
  onLatencyMeasured: (m: { direction: Direction; averageMs: number; sampleCount: number }) => void;
  /**
   * An audio device failed to open (start or restartAudio). 'input' is the direction's
   * capture device (mic / CABLE-B Output), 'output' its playback device (CABLE-A Input /
   * headset). Fired in addition to the directional error state on start.
   */
  onDeviceFailure?: (f: { direction: Direction; side: 'input' | 'output'; message: string }) => void;
  logger?: Logger;
  /** M6: request input transcription on both translate sessions with this model. */
  inputTranscriptionModel?: string;
  /** Voice of the translated speech (both directions); best effort, see OpenAISession. */
  voice?: string;
  /** M6: a direction's session rejected the input-transcription request (once per session). */
  onInputTranscriptionRejected?: (direction: Direction) => void;
}

interface DirectionContext {
  session: OpenAISession;
  pipeline: AudioPipeline;
}

export class SessionManager {
  private a: DirectionContext | undefined;
  private b: DirectionContext | undefined;

  constructor(private readonly cfg: SessionManagerConfig) {}

  /**
   * Starts both directions in parallel.
   *
   * **Caller contract on rejection:** if `start()` rejects, both directions have already
   * been torn down and the failed direction's error state has been (re-)emitted via
   * `onDirectionalState`. Calling `stop()` afterwards is safe (no-op).
   *
   * If both directions succeed, `start()` resolves once both are `active`.
   */
  async start(): Promise<void> {
    this.a = this.buildDirection(
      'A',
      this.cfg.sourceLang,
      this.cfg.targetLang,
      this.cfg.micDeviceId,
      this.cfg.toMeetDeviceId,
    );
    this.b = this.buildDirection(
      'B',
      this.cfg.targetLang,
      this.cfg.sourceLang,
      this.cfg.fromMeetDeviceId,
      this.cfg.headsetDeviceId,
    );

    // Start both pipelines in parallel; if one fails, tear both down, surface the error via
    // state and rethrow. Mid-call failures stay per-direction (degraded mode, spec §7).
    const results = await Promise.allSettled([
      this.startDirection('A', this.a.pipeline),
      this.startDirection('B', this.b.pipeline),
    ]);
    const failures = results
      .map((r, i) => ({ r, direction: (i === 0 ? 'A' : 'B') as Direction }))
      .filter(
        (x): x is { r: PromiseRejectedResult; direction: Direction } => x.r.status === 'rejected',
      );
    if (failures.length > 0) {
      // Tear down here (the caller's stop() then becomes a no-op) and re-emit each failed
      // direction's real error afterwards — session.stop() emits 'idle', which would
      // otherwise overwrite the cause shown in the UI.
      await this.stop();
      for (const f of failures) {
        const message = f.r.reason instanceof Error ? f.r.reason.message : String(f.r.reason);
        this.cfg.onDirectionalState({ direction: f.direction, state: { kind: 'error', message } });
      }
      throw failures[0]!.r.reason;
    }
  }

  private async startDirection(direction: Direction, pipeline: AudioPipeline): Promise<void> {
    try {
      await pipeline.start();
    } catch (err) {
      // Pipeline init failed before session.start() — emit an error state so the UI can
      // reflect this direction's failure (degraded mode, spec §7).
      const message = err instanceof Error ? err.message : String(err);
      this.reportDeviceFailure(direction, err);
      this.cfg.onDirectionalState({ direction, state: { kind: 'error', message } });
      throw err;
    }
  }

  /**
   * Re-opens one direction's capture + playback on the same devices while its session
   * keeps running (see AudioPipeline.restartAudio). Rejects if the direction isn't running
   * or a device fails to open; device failures are also reported via onDeviceFailure.
   */
  async restartAudio(direction: Direction): Promise<void> {
    const ctx = direction === 'A' ? this.a : this.b;
    if (!ctx) throw new Error(`direction ${direction} is not running`);
    try {
      await ctx.pipeline.restartAudio();
    } catch (err) {
      this.reportDeviceFailure(direction, err);
      throw err;
    }
  }

  private reportDeviceFailure(direction: Direction, err: unknown): void {
    if (err instanceof AudioDeviceError) {
      this.cfg.onDeviceFailure?.({ direction, side: err.side, message: err.message });
    }
  }

  async stop(): Promise<void> {
    // Pipeline.stop() is sync today (interface returns void), but `await Promise.all` is
    // future-proof: if the offscreen-controller stopStream ever becomes async, no churn here.
    await Promise.all([this.a?.pipeline.stop(), this.b?.pipeline.stop()]);
    this.a = undefined;
    this.b = undefined;
  }

  private buildDirection(
    direction: Direction,
    source: LanguageCode,
    target: LanguageCode,
    micDeviceId: string,
    outputDeviceId: string,
  ): DirectionContext {
    // Circular ref: session.events.onAudio needs to reach pipeline.handleSessionAudio,
    // but pipeline construction needs the session as a dep. Bind via mutable ref captured
    // by the closure, set after pipeline construction. Don't "simplify" by inlining —
    // it would break audio routing silently (closure would capture undefined).
    // eslint-disable-next-line prefer-const
    let pipelineRef: AudioPipeline | undefined;
    const session = new OpenAISession({
      apiKey: this.cfg.apiKey,
      sourceLang: source,
      targetLang: target,
      events: {
        onState: (s) => this.cfg.onDirectionalState({ direction, state: s }),
        onAudio: (b64) => pipelineRef?.handleSessionAudio(b64),
        onTranscript: (t) =>
          this.cfg.onTranscript({ direction, kind: t.kind, text: t.text }),
        onLatencyMeasured: (m) =>
          this.cfg.onLatencyMeasured({ direction, ...m }),
        ...(this.cfg.onInputTranscriptionRejected
          ? {
              onInputTranscriptionRejected: () =>
                this.cfg.onInputTranscriptionRejected?.(direction),
            }
          : {}),
      },
      wsFactory: this.cfg.wsFactory,
      ...(this.cfg.logger ? { logger: this.cfg.logger } : {}),
      ...(this.cfg.inputTranscriptionModel
        ? { inputTranscriptionModel: this.cfg.inputTranscriptionModel }
        : {}),
      ...(this.cfg.voice ? { voice: this.cfg.voice } : {}),
    });
    const pipeline = new AudioPipeline({
      streamId: direction,
      offscreen: this.cfg.offscreen,
      session,
      micDeviceId,
      outputDeviceId,
    });
    pipelineRef = pipeline;
    return { session, pipeline };
  }
}
