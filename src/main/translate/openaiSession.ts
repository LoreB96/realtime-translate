import type { SessionState } from '../../shared/types';
import type { LanguageCode } from '../../shared/languages';
import { ExponentialBackoff, type BackoffConfig } from '../util/retryPolicy';
import type { Logger } from '../util/logger';

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen?: () => void;
  onclose?: (code: number, reason: string) => void;
  onmessage?: (data: string) => void;
  onerror?: (err: Error) => void;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

export interface SessionEvents {
  onState: (s: SessionState) => void;
  onAudio: (base64: string) => void;
  onTranscript: (t: { kind: 'input' | 'output'; text: string }) => void;
  /** Optional: emitted after each turn (audio sent → delta received). */
  onLatencyMeasured?: (m: { averageMs: number; sampleCount: number }) => void;
  /**
   * Optional (M6): the server rejected the input-transcription session.update. Fired at most
   * once per session object; translation keeps running.
   */
  onInputTranscriptionRejected?: () => void;
}

export interface OpenAISessionConfig {
  apiKey: string;
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  events: SessionEvents;
  wsFactory: WebSocketFactory;
  voice?: string;
  /** Reconnect policy (spec §7). Default: 1s base / 30s cap / 5 attempts. */
  backoff?: BackoffConfig;
  /** Optional logger; if absent, all warn/error events go nowhere. */
  logger?: Logger;
  /**
   * Optional (M6): when set, a second session.update requests input transcription with this
   * model (e.g. 'gpt-realtime-whisper'). Whether the translations endpoint accepts it is
   * unverified; a rejection is latched and reported via onInputTranscriptionRejected.
   */
  inputTranscriptionModel?: string;
}

const ENDPOINT = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';
const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 1000, maxMs: 30000, maxAttempts: 5 };
/**
 * Cap on audio buffered while the socket is not open (~60 s @ 50 ms framing). Everything
 * buffered is sent once it opens — also after a reconnect — so nothing said during a
 * network hiccup goes untranslated; playback then catches up faster (see playbackPacing).
 */
export const MAX_PENDING_AUDIO = 1200;

export class OpenAISession {
  private ws?: WebSocketLike;
  private isOpen = false;
  private pendingAudio: string[] = [];
  private readonly backoff: ExponentialBackoff;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  /** True between user-initiated stop() and the next user-initiated start(). */
  private userStopped = false;
  /** True after a fatal failure (handshake rejected with 401/403/404) — disables reconnect
   * on subsequent close. */
  private serverError = false;
  /** Message of the most recent server {type:'error'} event; surfaced if reconnects run out. */
  private lastServerErrorMessage: string | undefined;
  /** User-visible reconnect attempt counter. Resets on successful (re)open and on start(). */
  private attemptCount = 0;
  /** False before the first successful open after start(); true thereafter. Distinguishes
   * startup-buffer flush (legitimate) from reconnect-buffer replay (compounds latency). */
  private hasOpenedOnce = false;
  /** True while we're in an overflow event — gates the warn log to once per event. Reset
   * on successful (re)open. */
  private hasLoggedOverflow = false;
  /** Timestamp of first chunk after the last received delta (start of current turn). */
  private turnStartMs: number | undefined;
  /** Ring buffer of the most recent turn latencies, max 5. */
  private readonly recentLatenciesMs: number[] = [];
  /** True once the input-transcription update was sent on the current socket. */
  private inputTranscriptionActive = false;
  /** Latched for the lifetime of this object: the server rejected input transcription, so
   * reconnects and later start() calls no longer send it. */
  private inputTranscriptionRejected = false;
  /** True once the voice update was sent on the current socket. */
  private voiceActive = false;
  /** Latched like inputTranscriptionRejected: the endpoint refused the voice parameter. */
  private voiceRejected = false;

  constructor(private readonly cfg: OpenAISessionConfig) {
    this.backoff = new ExponentialBackoff(cfg.backoff ?? DEFAULT_BACKOFF);
  }

  /**
   * User-initiated session start. Resets reconnect state and opens a fresh socket.
   * Internal reconnects use {@link connect} directly to preserve backoff progression.
   */
  start(): void {
    this.userStopped = false;
    this.serverError = false;
    this.lastServerErrorMessage = undefined;
    this.hasOpenedOnce = false;
    this.hasLoggedOverflow = false;
    this.backoff.reset();
    this.attemptCount = 0;
    this.recentLatenciesMs.length = 0;
    this.turnStartMs = undefined;
    this.connect();
  }

  appendAudio(base64: string): void {
    if (!this.isOpen) {
      // Bound the pre-connect buffer — drop oldest on overflow (M1).
      if (this.pendingAudio.length >= MAX_PENDING_AUDIO) {
        this.pendingAudio.shift();
        // Throttle: log once per overflow event, not per chunk. A multi-second
        // disconnect would otherwise produce hundreds of identical warnings.
        if (!this.hasLoggedOverflow) {
          this.hasLoggedOverflow = true;
          this.cfg.logger?.warn('pending_audio_overflow');
        }
      }
      this.pendingAudio.push(base64);
      return;
    }
    // Mark t0 of the current turn — only if we don't already have one in flight.
    // Reset happens when handleMessage receives output_audio.delta.
    if (this.turnStartMs === undefined) {
      this.turnStartMs = Date.now();
    }
    this.sendRaw({ type: 'session.input_audio_buffer.append', audio: base64 });
  }

  stop(): void {
    this.userStopped = true;
    // Cancel any pending reconnect (I1 + cancellation correctness).
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    // Drop any buffered audio so a future start() doesn't replay stale chunks (I1).
    this.pendingAudio = [];
    if (this.ws && !this.isClosed()) {
      this.ws.close(1000, 'client stop');
    }
    this.cfg.events.onState({ kind: 'idle' });
  }

  /** Open a WebSocket without resetting reconnect state. Used by start() and reconnect. */
  private connect(): void {
    this.inputTranscriptionActive = false;
    this.voiceActive = false;
    this.cfg.events.onState({ kind: 'connecting' });
    this.ws = this.cfg.wsFactory(ENDPOINT, {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      'OpenAI-Safety-Identifier': 'realtime-translate-client',
    });
    this.ws.onopen = () => this.handleOpen();
    this.ws.onmessage = (data) => this.handleMessage(data);
    this.ws.onclose = (code, reason) => this.handleClose(code, reason);
    this.ws.onerror = (err) => this.handleError(err);
  }

  private handleOpen(): void {
    // Guard against late-fire: if user called stop() or server sent an error
    // while the WebSocket was still in CONNECTING state, the onopen callback
    // can still fire. Bail out before emitting active state.
    if (this.userStopped || this.serverError) return;
    this.isOpen = true;
    // Successful (re)connect — reset backoff so next failure starts fresh. Not while a
    // server error is pending: a server that accepts the upgrade, sends an error and
    // closes would otherwise reset the counter every cycle and loop forever. The reset
    // then happens on the first translated audio (see handleMessage).
    if (this.lastServerErrorMessage === undefined) {
      this.backoff.reset();
      this.attemptCount = 0;
    }
    // The /v1/realtime/translations endpoint accepts only audio.output.language
    // (and optionally voice). Format is implicitly PCM16 24kHz mono per OpenAI docs.
    // Do NOT send input_audio_format / output_audio_format — those belong to the
    // /v1/realtime conversational endpoint and cause "Unknown parameter" errors here.
    // M6: input transcription is sent as a separate second update, see below.
    this.sendRaw({
      type: 'session.update',
      session: { audio: { output: { language: this.cfg.targetLang } } },
    });
    // Second update, only when requested. It repeats audio.output so the session is correct
    // whether the server merges or replaces session fields. A rejection arrives as an
    // 'error' event and is latched in handleMessage (translation is unaffected).
    if (this.cfg.inputTranscriptionModel && !this.inputTranscriptionRejected) {
      this.sendRaw({
        type: 'session.update',
        session: {
          audio: {
            output: { language: this.cfg.targetLang },
            input: { transcription: { model: this.cfg.inputTranscriptionModel } },
          },
        },
      });
      this.inputTranscriptionActive = true;
    }
    // Voice: its own update too (the translate endpoint does not document it). It goes out
    // before any audio, since a realtime voice cannot change after the first spoken reply; a
    // rejection is latched in handleMessage and the default voice stays.
    if (this.cfg.voice && !this.voiceRejected) {
      this.sendRaw({
        type: 'session.update',
        session: { audio: { output: { language: this.cfg.targetLang, voice: this.cfg.voice } } },
      });
      this.voiceActive = true;
    }
    // Flush audio captured while the socket was not open: the startup window after start()
    // and any reconnect gap. Never discarded — the user wants every word translated.
    for (const chunk of this.pendingAudio) {
      this.sendRaw({ type: 'session.input_audio_buffer.append', audio: chunk });
    }
    this.hasOpenedOnce = true;
    this.pendingAudio = [];
    this.hasLoggedOverflow = false;
    this.cfg.events.onState({ kind: 'active', sinceMs: Date.now() });
  }

  private handleMessage(raw: string): void {
    // Late frames from a socket we already closed must not reach playback: after a quick
    // restart the same streamId belongs to the new session.
    if (this.userStopped) return;
    let event: { type: string; delta?: string };
    try {
      event = JSON.parse(raw);
    } catch {
      // M4: best-effort warning. Don't include the raw payload — could leak transcript.
      this.cfg.logger?.warn('malformed_message_ignored');
      return;
    }
    if (event.type === 'session.output_audio.delta' && event.delta) {
      // Translated audio proves the session healthy: forget any earlier server error.
      if (this.lastServerErrorMessage !== undefined) {
        this.lastServerErrorMessage = undefined;
        this.backoff.reset();
        this.attemptCount = 0;
      }
      // Latency measurement: t1 - t0 for this turn.
      if (this.turnStartMs !== undefined) {
        const latency = Date.now() - this.turnStartMs;
        this.recentLatenciesMs.push(latency);
        if (this.recentLatenciesMs.length > 5) this.recentLatenciesMs.shift();
        const sum = this.recentLatenciesMs.reduce((a, b) => a + b, 0);
        const average = Math.round(sum / this.recentLatenciesMs.length);
        this.cfg.events.onLatencyMeasured?.({
          averageMs: average,
          sampleCount: this.recentLatenciesMs.length,
        });
        this.turnStartMs = undefined; // ready to start next turn on next appendAudio
      }
      this.cfg.events.onAudio(event.delta);
    } else if (event.type === 'session.input_transcript.delta' && event.delta) {
      this.cfg.events.onTranscript({ kind: 'input', text: event.delta });
    } else if (event.type === 'session.output_transcript.delta' && event.delta) {
      this.cfg.events.onTranscript({ kind: 'output', text: event.delta });
    } else if (event.type === 'error') {
      // Per the translation server-events reference, most errors are recoverable and the
      // session stays open. Don't latch: log it and keep translating. If the server does
      // close the socket afterwards, handleClose() applies the bounded backoff and the
      // final 'exhausted' error carries this message.
      const err = (
        event as { error?: { message?: string; code?: string; type?: string; param?: string } }
      ).error;
      if (this.voiceActive && /voice/i.test(`${err?.param ?? ''} ${err?.message ?? ''}`)) {
        this.voiceRejected = true;
        this.voiceActive = false;
        this.cfg.logger?.warn('voice_rejected', {
          code: err?.code ?? 'unknown',
          param: err?.param ?? 'unknown',
        });
        return;
      }
      if (
        this.inputTranscriptionActive &&
        /audio\.input|transcription/i.test(`${err?.param ?? ''} ${err?.message ?? ''}`)
      ) {
        // Rejection of the optional input-transcription update: latch it, report once, and
        // keep it out of lastServerErrorMessage so it neither blocks the backoff reset nor
        // surfaces as a translation failure. Never log the message.
        this.inputTranscriptionRejected = true;
        this.inputTranscriptionActive = false;
        this.cfg.logger?.warn('input_transcription_rejected', {
          code: err?.code ?? 'unknown',
          param: err?.param ?? 'unknown',
        });
        this.cfg.events.onInputTranscriptionRejected?.();
        return;
      }
      this.lastServerErrorMessage = err?.message ?? 'OpenAI server error';
      this.cfg.logger?.warn('server_error_event', {
        code: err?.code ?? 'unknown',
        type: err?.type ?? 'unknown',
        message: this.lastServerErrorMessage,
      });
    }
  }

  private handleClose(_code: number, _reason: string): void {
    this.isOpen = false;
    // User-initiated stop or fatal handshake rejection: do not reconnect.
    if (this.userStopped || this.serverError) return;
    this.scheduleReconnect();
  }

  private handleError(err: Error): void {
    // ws emits 'closed before the connection was established' when stop() closes a
    // CONNECTING socket — that is not a failure the user should see.
    if (this.userStopped) return;
    // ws reports a rejected HTTP upgrade as 'Unexpected server response: <status>'.
    // Invalid/revoked key (401), no model access (403/404) won't fix themselves by
    // retrying — treat as fatal so 'reconnecting' doesn't mask the real cause.
    if (/Unexpected server response: (401|403|404)\b/.test(err.message)) {
      this.serverError = true;
    }
    this.cfg.events.onState({ kind: 'error', message: err.message });
  }

  private scheduleReconnect(): void {
    if (!this.backoff.hasNext()) {
      const message = this.lastServerErrorMessage
        ? `reconnect attempts exhausted: ${this.lastServerErrorMessage}`
        : 'reconnect attempts exhausted';
      this.cfg.events.onState({ kind: 'error', message });
      return;
    }
    const delay = this.backoff.next();
    this.attemptCount += 1;
    this.cfg.events.onState({ kind: 'reconnecting', attempt: this.attemptCount });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      // Re-check stop flag at fire time in case stop() raced past the check above.
      if (this.userStopped || this.serverError) return;
      this.connect();
    }, delay);
  }

  private sendRaw(payload: object): void {
    this.ws?.send(JSON.stringify(payload));
  }

  private isClosed(): boolean {
    return !this.ws || this.ws.readyState === 3;
  }
}
