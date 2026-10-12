import { describe, it, expect } from 'vitest';
import type { TranscriptEntry } from '@shared/assistant';
import {
  NO_CONVERSATION_YET,
  PROMPT_MAX_CHARS,
  SUGGESTION_SCHEMA,
  buildSuggestionPrompt,
  buildTranslatePrompt,
  languageName,
  transcriptLines,
  translateMaxTokens,
  translateWith,
} from '@main/llm/prompts';
import type { CompleteOpts } from '@main/llm/llmClient';

let n = 0;
function entry(p: Partial<TranscriptEntry> & Pick<TranscriptEntry, 'speaker'>): TranscriptEntry {
  n += 1;
  return {
    id: `e-${n}`,
    direction: p.speaker === 'me' ? 'A' : 'B',
    source: 'translate',
    original: '',
    translated: '',
    originalLang: 'en',
    translatedLang: 'pt',
    startedAt: 0,
    updatedAt: 0,
    final: true,
    ...p,
  };
}

describe('prompts', () => {
  it('translateMaxTokens follows min(6000, ceil(chars/2)+1000)', () => {
    expect(translateMaxTokens(0)).toBe(1000);
    expect(translateMaxTokens(1)).toBe(1001);
    expect(translateMaxTokens(100)).toBe(1050);
    expect(translateMaxTokens(2000)).toBe(2000);
    expect(translateMaxTokens(10000)).toBe(6000);
    expect(translateMaxTokens(50000)).toBe(6000);
  });

  it('languageName returns English names', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('pt')).toBe('Portuguese');
    expect(languageName('it')).toBe('Italian');
  });

  it('buildTranslatePrompt uses the spec text', () => {
    const msgs = buildTranslatePrompt('Olá', 'pt', 'en');
    expect(msgs).toEqual([
      {
        role: 'system',
        content:
          "You translate chat messages for a live voice call. Translate the user's message from Portuguese to English. Keep the tone and register, keep names/numbers, do not add anything. Output only the translation.",
      },
      { role: 'user', content: 'Olá' },
    ]);
  });

  it('buildSuggestionPrompt uses the spec text and line format', () => {
    const msgs = buildSuggestionPrompt(
      [
        entry({ speaker: 'them', original: 'Você pode amanhã?', translated: 'Can you tomorrow?' }),
        entry({ speaker: 'them', original: 'Só original', translated: '' }),
        entry({ speaker: 'me', original: 'Yes I can', translated: 'Sim, posso' }),
        entry({ speaker: 'me', original: '', translated: 'only translated' }),
        entry({ speaker: 'me', original: '', translated: '' }),
      ],
      { user: 'en', them: 'pt' },
    );
    expect(msgs[0]).toEqual({
      role: 'system',
      content:
        'You help English speaker "Me" in a live call with "Them" (who speaks Portuguese). Based on the conversation, propose up to 3 short, natural replies Me could say next — especially if Them just asked a question. Each reply: max 2 sentences. Return JSON {"suggestions":[{"text":"<reply in English>","translation":"<same reply in Portuguese>"}]}. If no reply is needed, return {"suggestions":[]}.',
    });
    expect(msgs[1]).toEqual({
      role: 'user',
      content: [
        'Them: Can you tomorrow?',
        'Them: Só original',
        'Me: Yes I can',
        'Me: only translated',
      ].join('\n'),
    });
  });

  it('uses a placeholder when there is no conversation', () => {
    expect(buildSuggestionPrompt([], { user: 'en', them: 'pt' })[1]?.content).toBe(
      NO_CONVERSATION_YET,
    );
  });

  it('keeps at most the 30 newest entries', () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      entry({ speaker: 'them', translated: `line ${i}` }),
    );
    const lines = transcriptLines(entries);
    expect(lines).toHaveLength(30);
    expect(lines[0]).toBe('Them: line 10');
    expect(lines[29]).toBe('Them: line 39');
  });

  it('drops the oldest lines beyond 6000 chars', () => {
    const big = 'x'.repeat(2500);
    const entries = [
      entry({ speaker: 'me', original: `a${big}` }),
      entry({ speaker: 'me', original: `b${big}` }),
      entry({ speaker: 'me', original: `c${big}` }),
    ];
    const lines = transcriptLines(entries);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith('Me: b')).toBe(true);
    expect(lines.join('\n').length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
  });

  it('tail-truncates a single huge newest line', () => {
    const lines = transcriptLines([entry({ speaker: 'me', original: 'y'.repeat(9000) })]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBe(PROMPT_MAX_CHARS);
  });

  it('SUGGESTION_SCHEMA is strict-compatible', () => {
    expect(SUGGESTION_SCHEMA.name).toBe('reply_suggestions');
    const s = SUGGESTION_SCHEMA.schema as {
      additionalProperties: boolean;
      required: string[];
      properties: { suggestions: { maxItems: number; items: { additionalProperties: boolean } } };
    };
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(['suggestions']);
    expect(s.properties.suggestions.maxItems).toBe(3);
    expect(s.properties.suggestions.items.additionalProperties).toBe(false);
  });

  it('translateWith calls complete with the prompt and budget', async () => {
    const calls: CompleteOpts[] = [];
    const llm = {
      complete: async (o: CompleteOpts): Promise<string> => {
        calls.push(o);
        return 'Hello';
      },
    };
    const ctrl = new AbortController();
    await expect(translateWith(llm, 'Olá', 'pt', 'en', ctrl.signal)).resolves.toBe('Hello');
    expect(calls[0]?.maxTokens).toBe(translateMaxTokens(3));
    expect(calls[0]?.signal).toBe(ctrl.signal);
    expect(calls[0]?.messages).toEqual(buildTranslatePrompt('Olá', 'pt', 'en'));
  });

  it('translateWith skips the call when languages match', async () => {
    let called = false;
    const llm = {
      complete: async (): Promise<string> => {
        called = true;
        return '';
      },
    };
    await expect(translateWith(llm, 'Hi', 'en', 'en')).resolves.toBe('Hi');
    expect(called).toBe(false);
  });
});
