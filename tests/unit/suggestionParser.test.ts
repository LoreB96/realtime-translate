import { describe, it, expect } from 'vitest';
import { parseSuggestions } from '@main/llm/suggestionParser';
import { MAX_SPEAK_CHARS, MAX_TTS_INPUT_CHARS, isSpeakArgs } from '@shared/assistant';

describe('parseSuggestions', () => {
  it('parses the schema JSON', () => {
    const raw = JSON.stringify({
      suggestions: [
        { text: ' Sure, Tuesday works. ', translation: 'Claro, terça funciona.' },
        { text: 'Can we do Wednesday?', translation: 'Podemos na quarta?' },
      ],
    });
    expect(parseSuggestions(raw)).toEqual([
      { text: 'Sure, Tuesday works.', translation: 'Claro, terça funciona.' },
      { text: 'Can we do Wednesday?', translation: 'Podemos na quarta?' },
    ]);
  });

  it('strips a code fence', () => {
    const raw = '```json\n{"suggestions":[{"text":"Yes","translation":"Sim"}]}\n```';
    expect(parseSuggestions(raw)).toEqual([{ text: 'Yes', translation: 'Sim' }]);
  });

  it('finds JSON wrapped in prose', () => {
    const raw =
      'Here you go: {"suggestions":[{"text":"I agree {mostly}","translation":"Concordo"}]} Hope it helps.';
    expect(parseSuggestions(raw)).toEqual([{ text: 'I agree {mostly}', translation: 'Concordo' }]);
  });

  it('accepts a bare array of strings', () => {
    expect(parseSuggestions('["One", "  ", "Two"]')).toEqual([
      { text: 'One', translation: '' },
      { text: 'Two', translation: '' },
    ]);
  });

  it('falls back to numbered and bulleted lines', () => {
    const raw = 'Options:\n1. Sounds good.\n2) "Let me check."\n- **Maybe later.**\nThanks';
    expect(parseSuggestions(raw)).toEqual([
      { text: 'Sounds good.', translation: '' },
      { text: 'Let me check.', translation: '' },
      { text: 'Maybe later.', translation: '' },
    ]);
  });

  it('returns [] for garbage', () => {
    expect(parseSuggestions('no idea what you mean')).toEqual([]);
    expect(parseSuggestions('')).toEqual([]);
    expect(parseSuggestions('{"foo": 1}')).toEqual([]);
  });

  it('drops empty text and missing translations become empty strings', () => {
    const raw = '{"suggestions":[{"text":""},{"text":"Ok"},{"translation":"x"}]}';
    expect(parseSuggestions(raw)).toEqual([{ text: 'Ok', translation: '' }]);
  });

  it('caps at 3', () => {
    const raw = JSON.stringify({ suggestions: ['a', 'b', 'c', 'd', 'e'] });
    expect(parseSuggestions(raw)).toHaveLength(3);
    expect(parseSuggestions('1. a\n2. b\n3. c\n4. d')).toHaveLength(3);
  });

  it('returns an empty list for an explicit empty suggestions array', () => {
    expect(parseSuggestions('{"suggestions":[]}')).toEqual([]);
  });

  it('keeps only speakable suggestions: overlong text dropped, overlong translation blanked', () => {
    const raw = JSON.stringify({
      suggestions: [
        { text: 'x'.repeat(MAX_SPEAK_CHARS + 1), translation: 'y' },
        { text: 'Ok', translation: 'z'.repeat(MAX_TTS_INPUT_CHARS + 1) },
        { text: 'a'.repeat(MAX_SPEAK_CHARS), translation: 'b' },
      ],
    });
    const out = parseSuggestions(raw);
    expect(out).toEqual([
      { text: 'Ok', translation: '' },
      { text: 'a'.repeat(MAX_SPEAK_CHARS), translation: 'b' },
    ]);
    expect(isSpeakArgs({ text: out[1]!.text, translate: false, translation: 'b' })).toBe(true);
  });
});
