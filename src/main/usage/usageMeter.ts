/**
 * Counts what the paid services consume and turns it into an estimated spend (USD) since
 * app start or the last reset. No Electron imports: clock and timers are injected, the
 * caller broadcasts the snapshots. Never sees transcript or prompt content — only byte
 * counts, token counts, model names and session states.
 */
import type { Direction, SessionState } from '../../shared/types';
import {
  PCM24K_BYTES_PER_S,
  TRANSLATE_USD_PER_MIN,
  USAGE_SERVICES,
  emptyUsage,
  llmCallUsd,
  llmPrice,
  sttUsdPerMin,
  ttsUsdPerMin,
  type LlmPurpose,
  type UsageService,
  type UsageSnapshot,
} from '../../shared/usage';

/** Snapshots are pushed at most this often (and every tick while translating). */
export const USAGE_EMIT_MS = 1000;
/** Rough tokens per character when a reply carries no `usage` block. */
const CHARS_PER_TOKEN = 4;

export interface LlmUsageReport {
  purpose: LlmPurpose;
  baseUrl: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Character counts used when token counts are missing. */
  promptChars: number;
  completionChars: number;
}

export interface UsageMeterDeps {
  onChange: (s: UsageSnapshot) => void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

const SERVICE_OF_PURPOSE: Record<LlmPurpose, UsageService> = {
  suggest: 'suggest',
  test: 'suggest',
  speak: 'voice',
  their: 'transcribe',
};

export class UsageMeter {
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private usage: UsageSnapshot;
  /** Start of the running translation session per direction (billed while active). */
  private readonly activeSince = new Map<Direction, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: UsageMeterDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
    this.usage = emptyUsage(this.now());
  }

  /** Translation is billed per session-minute from 'active' until it leaves 'active'. */
  onTranslateState(direction: Direction, state: SessionState): void {
    const since = this.activeSince.get(direction);
    if (state.kind === 'active') {
      if (since === undefined) this.activeSince.set(direction, this.now());
    } else if (since !== undefined) {
      this.activeSince.delete(direction);
      this.addTranslateMinutes((this.now() - since) / 60_000);
    }
    this.schedule();
  }

  /** PCM16 24 kHz audio sent to the transcription service. */
  addSttAudio(bytes: number, model: string): void {
    const minutes = bytes / PCM24K_BYTES_PER_S / 60;
    this.add('transcribe', minutes * sttUsdPerMin(model), minutes, 0);
  }

  /** PCM16 24 kHz audio received from text to speech. */
  addTtsAudio(bytes: number, model: string): void {
    const minutes = bytes / PCM24K_BYTES_PER_S / 60;
    this.add('voice', minutes * ttsUsdPerMin(model), minutes, 0);
  }

  addLlm(r: LlmUsageReport): void {
    const price = llmPrice(r.baseUrl, r.model);
    const counted = r.promptTokens !== undefined && r.completionTokens !== undefined;
    const pin = counted ? r.promptTokens! : Math.ceil(r.promptChars / CHARS_PER_TOKEN);
    const pout = counted ? r.completionTokens! : Math.ceil(r.completionChars / CHARS_PER_TOKEN);
    if (price.paid && (!counted || price.guessed)) this.usage.estimated = true;
    this.add(SERVICE_OF_PURPOSE[r.purpose], llmCallUsd(price, pin, pout), 0, 1);
  }

  snapshot(): UsageSnapshot {
    const s: UsageSnapshot = {
      ...this.usage,
      translate: { ...this.usage.translate },
      transcribe: { ...this.usage.transcribe },
      suggest: { ...this.usage.suggest },
      voice: { ...this.usage.voice },
    };
    const now = this.now();
    for (const since of this.activeSince.values()) {
      const minutes = Math.max(0, now - since) / 60_000;
      s.translate.minutes += minutes;
      s.translate.usd += minutes * TRANSLATE_USD_PER_MIN;
    }
    s.totalUsd = USAGE_SERVICES.reduce((sum, k) => sum + s[k].usd, 0);
    return s;
  }

  /** Starts a new count from now; running translation sessions keep billing from now. */
  reset(): void {
    const now = this.now();
    this.usage = emptyUsage(now);
    for (const d of [...this.activeSince.keys()]) this.activeSince.set(d, now);
    this.emitNow();
  }

  dispose(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private addTranslateMinutes(minutes: number): void {
    if (minutes <= 0) return;
    this.add('translate', minutes * TRANSLATE_USD_PER_MIN, minutes, 0);
  }

  private add(service: UsageService, usd: number, minutes: number, calls: number): void {
    const u = this.usage[service];
    u.usd += usd;
    u.minutes += minutes;
    u.calls += calls;
    this.schedule();
  }

  /** Coalesces changes into one push per USAGE_EMIT_MS; keeps ticking while translating. */
  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.deps.onChange(this.snapshot());
      if (this.activeSince.size > 0) this.schedule();
    }, USAGE_EMIT_MS);
  }

  private emitNow(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.deps.onChange(this.snapshot());
    if (this.activeSince.size > 0) this.schedule();
  }
}
