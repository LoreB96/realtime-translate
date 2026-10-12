/**
 * Prompt builders and token budgets for the assistant LLM calls (spec §6.3). Pure except
 * `translateWith`, which only forwards to an injected client.
 */
import type { TranscriptEntry } from '../../shared/assistant';
import { languageByCode, type LanguageCode } from '../../shared/languages';
import type { ChatMessage, LlmClient } from './llmClient';

export const SUGGEST_MAX_TOKENS = 2000;
export const TEST_MAX_TOKENS = 512;
export const PROMPT_MAX_ENTRIES = 30;
export const PROMPT_MAX_CHARS = 6000;

export function translateMaxTokens(chars: number): number {
  return Math.min(6000, Math.ceil(chars / 2) + 1000);
}

/** English language name (e.g. 'Portuguese'); falls back to the code. */
export function languageName(code: LanguageCode): string {
  return languageByCode(code)?.label ?? code;
}

export function buildTranslatePrompt(
  text: string,
  from: LanguageCode,
  to: LanguageCode,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        `You translate chat messages for a live voice call. Translate the user's message from ` +
        `${languageName(from)} to ${languageName(to)}. Keep the tone and register, keep ` +
        `names/numbers, do not add anything. Output only the translation.`,
    },
    { role: 'user', content: text },
  ];
}

function lineOf(e: TranscriptEntry): string | undefined {
  const text = (e.speaker === 'them' ? e.translated || e.original : e.original || e.translated)
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return undefined;
  return `${e.speaker === 'them' ? 'Them' : 'Me'}: ${text}`;
}

/**
 * Transcript lines oldest → newest, bounded by PROMPT_MAX_ENTRIES / PROMPT_MAX_CHARS by
 * dropping the oldest lines. The newest line is always kept (tail-truncated if huge).
 */
export function transcriptLines(entries: TranscriptEntry[]): string[] {
  const out: string[] = [];
  let chars = 0;
  for (let i = entries.length - 1; i >= 0 && out.length < PROMPT_MAX_ENTRIES; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    const line = lineOf(entry);
    if (line === undefined) continue;
    if (out.length === 0 && line.length > PROMPT_MAX_CHARS) {
      out.push(line.slice(line.length - PROMPT_MAX_CHARS));
      break;
    }
    const cost = line.length + (out.length > 0 ? 1 : 0);
    if (chars + cost > PROMPT_MAX_CHARS) break;
    chars += cost;
    out.push(line);
  }
  return out.reverse();
}

export const NO_CONVERSATION_YET = '(The conversation has not started yet.)';

export function buildSuggestionPrompt(
  entries: TranscriptEntry[],
  langs: { user: LanguageCode; them: LanguageCode },
): ChatMessage[] {
  const user = languageName(langs.user);
  const them = languageName(langs.them);
  const lines = transcriptLines(entries);
  return [
    {
      role: 'system',
      content:
        `You help ${user} speaker "Me" in a live call with "Them" (who speaks ${them}). ` +
        `Based on the conversation, propose up to 3 short, natural replies Me could say next ` +
        `— especially if Them just asked a question. Each reply: max 2 sentences. Return JSON ` +
        `{"suggestions":[{"text":"<reply in ${user}>","translation":"<same reply in ${them}>"}]}. ` +
        `If no reply is needed, return {"suggestions":[]}.`,
    },
    { role: 'user', content: lines.length > 0 ? lines.join('\n') : NO_CONVERSATION_YET },
  ];
}

export const SUGGESTION_SCHEMA: { name: 'reply_suggestions'; schema: object } = {
  name: 'reply_suggestions',
  schema: {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            translation: { type: 'string' },
          },
          required: ['text', 'translation'],
          additionalProperties: false,
        },
      },
    },
    required: ['suggestions'],
    additionalProperties: false,
  },
};

/**
 * Convenience used by U11a (typed speech + their-speech translation). Returns the text
 * unchanged when `from === to` (spec: callers skip translation then).
 */
export function translateWith(
  llm: Pick<LlmClient, 'complete'>,
  text: string,
  from: LanguageCode,
  to: LanguageCode,
  signal?: AbortSignal,
): Promise<string> {
  if (from === to) return Promise.resolve(text);
  return llm.complete({
    messages: buildTranslatePrompt(text, from, to),
    maxTokens: translateMaxTokens(text.length),
    ...(signal ? { signal } : {}),
  });
}
