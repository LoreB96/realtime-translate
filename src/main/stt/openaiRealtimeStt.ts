/**
 * OpenAI realtime transcription for one passthrough stream (spec §6.2.1).
 * No Electron imports: the WebSocket, timers and logger are injected.
 */
import type { AssistantErrorCode } from '../../shared/assistant';
import type { WebSocketFactory, WebSocketLike } from '../translate/openaiSession';
import type { Logger } from '../util/logger';
import { ExponentialBackoff, type BackoffConfig } from '../util/retryPolicy';
import { buildSttSessionUpdate, OPENAI_STT_URL, parseSttEvent } from './openaiSttProtocol';
import type { SttEngineFactory, SttEngineInstance, SttSegment, SttTarget } from './sttTypes';

export const COMMIT_IDLE_MS = 350;
export const MIN_COMMIT_MS = 200;
export const MAX_SEGMENT_MS = 15000;

/** Pre-open PCM queue cap (chunks); the oldest chunk is dropped on overflow. */
const MAX_PENDING_PCM = 100;
const MAX_SEGMENT_ID_CHARS = 80;
const PCM_RATE = 24000;
const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 1000, maxMs: 30000, maxAttempts: 5 };

type Timer = ReturnType<typeof setTimeout>;

export interface OpenAiRealtimeSttConfig {
  apiKey: string;
  model: string;
  target: SttTarget;
  wsFactory: WebSocketFactory;
  onSegment: (s: SttSegment) => void;
  onError: (c: AssistantErrorCode) => void;
  backoff?: BackoffConfig;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  logger?: Logger;
}

/** Decoded byte length of a base64 string (no decoding). */
function base64ByteLength(b64: string): number {
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

export class OpenAiRealtimeStt implements SttEngineInstance {
  private ws: WebSocketLike | undefined;
  private isOpen = false;
  private stopped = true;
  /** A fatal server error or rejected handshake: never reconnect. */
  private fatal = false;
  private pending: string[] = [];
  private uncommittedMs = 0;
  private idleTimer: Timer | undefined;
  private reconnectTimer: Timer | undefined;
  private attemptCount = 0;
  /**
   * A non-fatal server error arrived on the current socket (other than routine expiry): the
   * next open must not reset the backoff, or an "error then close" server loops forever.
   */
  private serverErrorSinceOpen = false;
  private readonly backoff: ExponentialBackoff;

  constructor(private readonly cfg: OpenAiRealtimeSttConfig) {
    this.backoff = new ExponentialBackoff(cfg.backoff ?? DEFAULT_BACKOFF);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.fatal = false;
    this.backoff.reset();
    this.attemptCount = 0;
    this.serverErrorSinceOpen = false;
    this.connect();
  }

  appendPcm(b64: string): void {
    if (this.stopped || this.fatal || b64.length === 0) return;
    if (!this.isOpen) {
      if (this.pending.length >= MAX_PENDING_PCM) this.pending.shift();
      this.pending.push(b64);
      return;
    }
    this.sendAppend(b64);
    this.armIdleTimer();
  }

  stop(): void {
    this.stopped = true;
    this.clearIdleTimer();
    if (this.reconnectTimer !== undefined) {
      this.clear(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.pending = [];
    this.uncommittedMs = 0;
    this.closeSocket(1000, 'client stop');
  }

  // -------------------------------------------------------------------------

  private connect(): void {
    this.isOpen = false;
    const ws = this.cfg.wsFactory(OPENAI_STT_URL, {
      Authorization: `Bearer ${this.cfg.apiKey}`,
    });
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws === ws) this.handleOpen();
    };
    ws.onmessage = (data) => {
      if (this.ws === ws) this.handleMessage(data);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.handleClose();
    };
    ws.onerror = (err) => {
      if (this.ws === ws) this.handleError(err);
    };
  }

  private handleOpen(): void {
    if (this.stopped || this.fatal) return;
    this.isOpen = true;
    // Reset unless the previous socket reported a (non-fatal) server error before closing:
    // periodic server-side session expiry must never exhaust the budget, but a server that
    // accepts and then errors/closes every socket must eventually surface stt-failed.
    if (!this.serverErrorSinceOpen) {
      this.backoff.reset();
      this.attemptCount = 0;
    }
    this.serverErrorSinceOpen = false;
    this.uncommittedMs = 0;
    const { streamId, lang, direction } = this.cfg.target;
    this.cfg.logger?.info('stt_session_open', { streamId, model: this.cfg.model });
    this.send(buildSttSessionUpdate(this.cfg.model, lang, direction === 'A'));
    const queued = this.pending;
    this.pending = [];
    for (const chunk of queued) this.sendAppend(chunk);
    if (queued.length > 0) this.armIdleTimer();
  }

  private handleMessage(raw: string): void {
    if (this.stopped) return;
    const ev = parseSttEvent(raw);
    if (!ev) return;
    const { direction } = this.cfg.target;
    switch (ev.kind) {
      case 'delta':
        this.cfg.onSegment({
          id: this.segmentId(ev.itemId),
          direction,
          text: ev.text,
          final: false,
          mode: 'append',
        });
        return;
      case 'completed':
        this.cfg.onSegment({
          id: this.segmentId(ev.itemId),
          direction,
          text: ev.text,
          final: true,
          mode: 'replace',
        });
        return;
      case 'failed':
        this.cfg.logger?.warn('stt_item_failed', { streamId: this.cfg.target.streamId });
        this.cfg.onSegment({
          id: this.segmentId(ev.itemId),
          direction,
          text: '',
          final: true,
          mode: 'append',
        });
        return;
      case 'error': {
        const param = ev.param ?? 'unknown';
        this.cfg.logger?.warn('stt_server_error', { code: ev.code, type: ev.type, param });
        if (ev.fatal) {
          this.cfg.logger?.warn('stt_session_rejected', { code: ev.code, param });
          this.failFatal();
        } else if (ev.code !== 'session_expired') {
          this.serverErrorSinceOpen = true;
        }
        return;
      }
    }
  }

  private handleClose(): void {
    this.isOpen = false;
    this.clearIdleTimer();
    // The server-side buffer is gone with the socket; queued PCM is stale (live audio wins).
    this.uncommittedMs = 0;
    this.pending = [];
    if (this.stopped || this.fatal) return;
    if (!this.backoff.hasNext()) {
      this.cfg.logger?.warn('stt_reconnect_exhausted', { streamId: this.cfg.target.streamId });
      this.fatal = true;
      this.cfg.onError('stt-failed');
      return;
    }
    const delay = this.backoff.next();
    this.attemptCount += 1;
    this.cfg.logger?.info('stt_reconnecting', {
      streamId: this.cfg.target.streamId,
      attempt: this.attemptCount,
      delayMs: delay,
    });
    this.reconnectTimer = this.set(() => {
      this.reconnectTimer = undefined;
      if (this.stopped || this.fatal) return;
      this.connect();
    }, delay);
  }

  private handleError(err: Error): void {
    if (this.stopped) return;
    // ws reports a rejected HTTP upgrade as 'Unexpected server response: <status>'. A bad
    // key or no model access will not fix itself by retrying.
    const m = /Unexpected server response: (\d{3})\b/.exec(err.message);
    const status = m ? Number(m[1]) : undefined;
    this.cfg.logger?.warn('stt_ws_error', {
      streamId: this.cfg.target.streamId,
      ...(status !== undefined ? { status } : {}),
    });
    if (status === 401 || status === 403 || status === 404) {
      this.cfg.logger?.warn('stt_session_rejected', { code: `http_${status}`, param: 'unknown' });
      this.failFatal();
    }
  }

  private failFatal(): void {
    if (this.fatal) return;
    this.fatal = true;
    this.clearIdleTimer();
    this.pending = [];
    this.closeSocket(1000, 'stt rejected');
    this.cfg.onError('stt-failed');
  }

  private sendAppend(b64: string): void {
    this.send({ type: 'input_audio_buffer.append', audio: b64 });
    this.uncommittedMs += (base64ByteLength(b64) / 2 / PCM_RATE) * 1000;
    if (this.uncommittedMs >= MAX_SEGMENT_MS) this.commit();
  }

  private commit(): void {
    this.clearIdleTimer();
    if (!this.isOpen) return;
    this.send({ type: 'input_audio_buffer.commit' });
    this.uncommittedMs = 0;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = this.set(() => {
      this.idleTimer = undefined;
      if (this.stopped || !this.isOpen) return;
      if (this.uncommittedMs >= MIN_COMMIT_MS) this.commit();
    }, COMMIT_IDLE_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      this.clear(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private segmentId(itemId: string): string {
    return `${this.cfg.target.streamId}-${itemId}`.slice(0, MAX_SEGMENT_ID_CHARS);
  }

  private send(payload: object): void {
    this.ws?.send(JSON.stringify(payload));
  }

  private closeSocket(code: number, reason: string): void {
    const ws = this.ws;
    this.isOpen = false;
    if (ws && ws.readyState !== 3) ws.close(code, reason);
  }

  private set(fn: () => void, ms: number): Timer {
    return (this.cfg.setTimer ?? setTimeout)(fn, ms);
  }

  private clear(t: Timer): void {
    (this.cfg.clearTimer ?? clearTimeout)(t);
  }
}

export function createOpenAiSttFactory(deps: {
  apiKey: () => string | undefined;
  model: () => string;
  wsFactory: WebSocketFactory;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  logger?: Logger;
}): SttEngineFactory {
  return {
    create(target, onSegment, onError) {
      const apiKey = deps.apiKey();
      if (!apiKey) {
        onError('no-openai-key');
        return { stop() {} };
      }
      const engine = new OpenAiRealtimeStt({
        apiKey,
        model: deps.model(),
        target,
        wsFactory: deps.wsFactory,
        onSegment,
        onError,
        ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
        ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
      });
      engine.start();
      return engine;
    },
  };
}
