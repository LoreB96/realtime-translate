import { describe, it, expect, vi } from 'vitest';
import { UsageMeter, USAGE_EMIT_MS } from '@main/usage/usageMeter';
import {
  PCM24K_BYTES_PER_S,
  TRANSLATE_USD_PER_MIN,
  formatUsd,
  hourlyEstimates,
  llmPrice,
  sttUsdPerMin,
  type UsageSnapshot,
} from '@shared/usage';

const MIN = 60_000;
const ONE_MIN_PCM = PCM24K_BYTES_PER_S * 60;

function setup(): {
  meter: UsageMeter;
  clock: { now: number };
  pushes: UsageSnapshot[];
} {
  const clock = { now: 1_000_000 };
  const pushes: UsageSnapshot[] = [];
  const meter = new UsageMeter({ onChange: (s) => pushes.push(s), now: () => clock.now });
  return { meter, clock, pushes };
}

describe('UsageMeter', () => {
  it('bills translation per session-minute and direction, live while active', () => {
    const { meter, clock } = setup();
    meter.onTranslateState('A', { kind: 'active', sinceMs: clock.now });
    meter.onTranslateState('B', { kind: 'active', sinceMs: clock.now });
    clock.now += 2 * MIN;
    expect(meter.snapshot().translate.usd).toBeCloseTo(4 * TRANSLATE_USD_PER_MIN, 6);
    meter.onTranslateState('A', { kind: 'idle' });
    meter.onTranslateState('B', { kind: 'reconnecting', attempt: 1 });
    clock.now += 10 * MIN;
    const s = meter.snapshot();
    expect(s.translate.minutes).toBeCloseTo(4, 6);
    expect(s.translate.usd).toBeCloseTo(4 * TRANSLATE_USD_PER_MIN, 6);
    expect(s.totalUsd).toBeCloseTo(s.translate.usd, 9);
    meter.dispose();
  });

  it('a repeated active state does not restart the session clock', () => {
    const { meter, clock } = setup();
    meter.onTranslateState('A', { kind: 'active', sinceMs: clock.now });
    clock.now += MIN;
    meter.onTranslateState('A', { kind: 'active', sinceMs: clock.now });
    clock.now += MIN;
    expect(meter.snapshot().translate.minutes).toBeCloseTo(2, 6);
    meter.dispose();
  });

  it('bills transcription and speech by audio minutes and model', () => {
    const { meter } = setup();
    meter.addSttAudio(ONE_MIN_PCM, 'gpt-4o-transcribe');
    meter.addTtsAudio(ONE_MIN_PCM / 2, 'gpt-4o-mini-tts');
    const s = meter.snapshot();
    expect(s.transcribe.usd).toBeCloseTo(0.006, 9);
    expect(s.transcribe.minutes).toBeCloseTo(1, 9);
    expect(s.voice.usd).toBeCloseTo(0.0075, 9);
    meter.dispose();
  });

  it('assigns LLM calls by purpose and prices only OpenAI models', () => {
    const { meter } = setup();
    const base = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', promptChars: 0, completionChars: 0 };
    meter.addLlm({ ...base, purpose: 'suggest', promptTokens: 1_000_000, completionTokens: 0 });
    meter.addLlm({ ...base, purpose: 'speak', promptTokens: 0, completionTokens: 1_000_000 });
    meter.addLlm({ ...base, purpose: 'their', promptTokens: 1_000_000, completionTokens: 0 });
    meter.addLlm({
      purpose: 'suggest',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:8b',
      promptChars: 4000,
      completionChars: 4000,
    });
    const s = meter.snapshot();
    expect(s.suggest.usd).toBeCloseTo(0.25, 9);
    expect(s.suggest.calls).toBe(2);
    expect(s.voice.usd).toBeCloseTo(2, 9);
    expect(s.transcribe.usd).toBeCloseTo(0.25, 9);
    // Local model without usage block: free, so not an estimate either.
    expect(s.estimated).toBe(false);
    meter.dispose();
  });

  it('estimates from characters when the reply has no usage block, and says so', () => {
    const { meter } = setup();
    meter.addLlm({
      purpose: 'suggest',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5-mini',
      promptChars: 4_000_000,
      completionChars: 0,
    });
    const s = meter.snapshot();
    expect(s.suggest.usd).toBeCloseTo(0.25, 9);
    expect(s.estimated).toBe(true);
    meter.dispose();
  });

  it('pushes coalesced snapshots, keeps ticking while translating, and stops after', () => {
    vi.useFakeTimers();
    try {
      const clock = { now: 0 };
      const pushes: UsageSnapshot[] = [];
      const meter = new UsageMeter({ onChange: (s) => pushes.push(s), now: () => clock.now });
      meter.addSttAudio(1000, 'gpt-4o-mini-transcribe');
      meter.addSttAudio(1000, 'gpt-4o-mini-transcribe');
      vi.advanceTimersByTime(USAGE_EMIT_MS);
      expect(pushes).toHaveLength(1);
      vi.advanceTimersByTime(5 * USAGE_EMIT_MS);
      expect(pushes).toHaveLength(1);

      meter.onTranslateState('A', { kind: 'active', sinceMs: 0 });
      vi.advanceTimersByTime(3 * USAGE_EMIT_MS);
      expect(pushes).toHaveLength(4);
      meter.onTranslateState('A', { kind: 'idle' });
      vi.advanceTimersByTime(5 * USAGE_EMIT_MS);
      expect(pushes).toHaveLength(5);
      meter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset starts a new count from now and pushes it at once', () => {
    const { meter, clock, pushes } = setup();
    meter.onTranslateState('A', { kind: 'active', sinceMs: clock.now });
    meter.addSttAudio(ONE_MIN_PCM, 'gpt-4o-mini-transcribe');
    clock.now += 5 * MIN;
    meter.reset();
    expect(pushes.at(-1)?.totalUsd).toBe(0);
    expect(pushes.at(-1)?.sinceMs).toBe(clock.now);
    clock.now += MIN;
    expect(meter.snapshot().translate.minutes).toBeCloseTo(1, 6);
    meter.dispose();
  });
});

describe('pricing helpers', () => {
  it('prices dated OpenAI snapshots like their base model and flags unknown ones', () => {
    expect(llmPrice('https://api.openai.com/v1', 'gpt-5-mini-2025-08-07')).toEqual({
      in: 0.25,
      out: 2,
      paid: true,
      guessed: false,
    });
    expect(llmPrice('https://api.openai.com/v1', 'gpt-9-ultra').guessed).toBe(true);
    expect(llmPrice('http://127.0.0.1:1234/v1', 'gpt-5').paid).toBe(false);
  });

  it('gives per-hour estimates for the panel', () => {
    const e = hourlyEstimates({
      sttModel: 'gpt-4o-mini-transcribe',
      ttsModel: 'gpt-4o-mini-tts',
      llmBaseUrl: 'http://127.0.0.1:11434/v1',
      llmModel: 'qwen3:8b',
    });
    expect(e.translate).toBeCloseTo(2 * TRANSLATE_USD_PER_MIN * 60, 9);
    expect(e.transcribe).toBeCloseTo(2 * sttUsdPerMin('gpt-4o-mini-transcribe') * 60, 9);
    expect(e.suggest).toBe(0);
    expect(e.voicePerMin).toBeCloseTo(0.015, 9);
  });

  it('formats small amounts with enough precision', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0042)).toBe('$0.004');
    expect(formatUsd(4.08)).toBe('$4.08');
  });
});
