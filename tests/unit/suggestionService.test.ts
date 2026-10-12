import { describe, it, expect, vi } from 'vitest';
import type { SuggestionsState, TranscriptEntry } from '@shared/assistant';
import { SuggestionService } from '@main/llm/suggestionService';
import { LlmError } from '@main/llm/llmErrors';
import { SUGGESTION_SCHEMA, SUGGEST_MAX_TOKENS } from '@main/llm/prompts';
import type { CompleteOpts } from '@main/llm/llmClient';

interface Pending {
  opts: CompleteOpts;
  resolve: (s: string) => void;
  reject: (e: unknown) => void;
}

let n = 0;
function entry(p: Partial<TranscriptEntry> & Pick<TranscriptEntry, 'speaker'>): TranscriptEntry {
  n += 1;
  return {
    id: `e-${n}`,
    direction: p.speaker === 'me' ? 'A' : 'B',
    source: 'translate',
    original: '',
    translated: '',
    originalLang: 'pt',
    translatedLang: 'en',
    startedAt: 0,
    updatedAt: 0,
    final: true,
    ...p,
  };
}

function setup(opts: { suggestions?: boolean; auto?: boolean } = {}) {
  const pending: Pending[] = [];
  const states: SuggestionsState[] = [];
  const enabled = { suggestions: opts.suggestions ?? true, auto: opts.auto ?? true };
  const llm = {
    complete: (o: CompleteOpts): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        pending.push({ opts: o, resolve, reject });
        o.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  };
  const svc = new SuggestionService({
    llm,
    recent: () => [entry({ speaker: 'them', translated: 'How are you?' })],
    langs: () => ({ user: 'en', them: 'pt' }),
    enabled: () => enabled,
    onState: (s) => states.push(s),
    now: () => Date.now(),
  });
  return { svc, pending, states, enabled };
}

const READY_JSON = '{"suggestions":[{"text":"Fine, thanks","translation":"Bem, obrigado"}]}';

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('SuggestionService', () => {
  it('debounces a them entry by 1200 ms, then loads and becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const { svc, pending, states } = setup();
      const e = entry({ speaker: 'them', original: 'Tudo bem', translated: 'All good' });
      svc.onFinalEntry(e);
      await vi.advanceTimersByTimeAsync(1199);
      expect(pending).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.opts.maxTokens).toBe(SUGGEST_MAX_TOKENS);
      expect(pending[0]?.opts.jsonSchema).toBe(SUGGESTION_SCHEMA);
      expect(svc.state()).toMatchObject({ status: 'loading', forEntryId: e.id });
      pending[0]?.resolve(READY_JSON);
      await flush();
      expect(svc.state()).toMatchObject({
        status: 'ready',
        forEntryId: e.id,
        items: [{ text: 'Fine, thanks', translation: 'Bem, obrigado' }],
      });
      expect(states.map((s) => s.status)).toEqual(['loading', 'ready']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses 300 ms for a question (ASCII and full-width)', async () => {
    vi.useFakeTimers();
    try {
      const { svc, pending } = setup();
      svc.onFinalEntry(entry({ speaker: 'them', translated: 'Can you come?' }));
      await vi.advanceTimersByTimeAsync(300);
      expect(pending).toHaveLength(1);
      svc.onFinalEntry(entry({ speaker: 'them', original: '你 来 吗？', translated: '' }));
      await vi.advanceTimersByTimeAsync(300);
      expect(pending).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the debounce on each trigger', async () => {
    vi.useFakeTimers();
    try {
      const { svc, pending } = setup();
      svc.onFinalEntry(entry({ speaker: 'them', translated: 'first part' }));
      await vi.advanceTimersByTimeAsync(1000);
      svc.onFinalEntry(entry({ speaker: 'them', translated: 'second part' }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(pending).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(pending).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a new trigger aborts the old request and a stale result is ignored', async () => {
    vi.useFakeTimers();
    try {
      const { svc, pending, states } = setup();
      svc.onFinalEntry(entry({ speaker: 'them', translated: 'one two?' }));
      await vi.advanceTimersByTimeAsync(300);
      const first = pending[0];
      expect(first?.opts.signal?.aborted).toBe(false);
      const second = entry({ speaker: 'them', translated: 'three four?' });
      svc.onFinalEntry(second);
      await vi.advanceTimersByTimeAsync(300);
      expect(first?.opts.signal?.aborted).toBe(true);
      expect(pending).toHaveLength(2);
      pending[1]?.resolve(READY_JSON);
      await flush();
      expect(svc.state()).toMatchObject({ status: 'ready', forEntryId: second.id });
      expect(states.some((s) => s.status === 'error')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a late result that resolves after a newer request started', async () => {
    const { svc, pending } = setup();
    const p1 = svc.requestNow();
    const p2 = svc.requestNow();
    // first request resolves late (its fake ignores the abort rejection order)
    pending[1]?.resolve('{"suggestions":[{"text":"new one","translation":""}]}');
    pending[0]?.resolve('{"suggestions":[{"text":"old one","translation":""}]}');
    await Promise.all([p1, p2]);
    expect(svc.state().items).toEqual([{ text: 'new one', translation: '' }]);
    expect(svc.state().forEntryId).toBeUndefined();
  });

  it('ignores one-word them entries and respects autoSuggest / disabled', async () => {
    vi.useFakeTimers();
    try {
      const a = setup();
      a.svc.onFinalEntry(entry({ speaker: 'them', translated: 'Okay.' }));
      await vi.advanceTimersByTimeAsync(5000);
      expect(a.pending).toHaveLength(0);

      const b = setup({ auto: false });
      b.svc.onFinalEntry(entry({ speaker: 'them', translated: 'How are you?' }));
      await vi.advanceTimersByTimeAsync(5000);
      expect(b.pending).toHaveLength(0);

      const c = setup({ suggestions: false });
      c.svc.onFinalEntry(entry({ speaker: 'them', translated: 'How are you?' }));
      await vi.advanceTimersByTimeAsync(5000);
      await c.svc.requestNow();
      expect(c.pending).toHaveLength(0);
      expect(c.states).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire when suggestions get disabled during the debounce', async () => {
    vi.useFakeTimers();
    try {
      const { svc, pending, enabled } = setup();
      svc.onFinalEntry(entry({ speaker: 'them', translated: 'How are you?' }));
      enabled.suggestions = false;
      await vi.advanceTimersByTimeAsync(5000);
      expect(pending).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requestNow ignores autoSuggest and runs immediately', async () => {
    const { svc, pending } = setup({ auto: false });
    const p = svc.requestNow();
    expect(pending).toHaveLength(1);
    pending[0]?.resolve(READY_JSON);
    await p;
    expect(svc.state().status).toBe('ready');
  });

  it('a voice me entry with ≥ 2 words clears ready; typed and one-word do not', async () => {
    const { svc, pending } = setup();
    const p = svc.requestNow();
    pending[0]?.resolve(READY_JSON);
    await p;
    expect(svc.state().status).toBe('ready');

    svc.onFinalEntry(entry({ speaker: 'me', source: 'typed', original: 'Fine thanks a lot' }));
    expect(svc.state().status).toBe('ready');
    svc.onFinalEntry(entry({ speaker: 'me', source: 'stt', original: 'Hmm' }));
    expect(svc.state().status).toBe('ready');
    svc.onFinalEntry(entry({ speaker: 'me', source: 'stt', original: 'I am fine' }));
    expect(svc.state()).toMatchObject({ status: 'idle', items: [] });
  });

  it('maps LlmError codes and other errors to unknown', async () => {
    const { svc, pending } = setup();
    let p = svc.requestNow();
    pending[0]?.reject(new LlmError('llm-unreachable'));
    await p;
    expect(svc.state()).toMatchObject({ status: 'error', errorCode: 'llm-unreachable', items: [] });

    p = svc.requestNow();
    pending[1]?.reject(new Error('weird'));
    await p;
    expect(svc.state()).toMatchObject({ status: 'error', errorCode: 'unknown' });
  });

  it('cancel aborts, clears the timer and goes idle', async () => {
    vi.useFakeTimers();
    try {
      const { svc, pending } = setup();
      const p = svc.requestNow();
      svc.cancel();
      await p;
      expect(pending[0]?.opts.signal?.aborted).toBe(true);
      expect(svc.state().status).toBe('idle');

      svc.onFinalEntry(entry({ speaker: 'them', translated: 'How are you?' }));
      svc.cancel();
      await vi.advanceTimersByTimeAsync(5000);
      expect(pending).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
