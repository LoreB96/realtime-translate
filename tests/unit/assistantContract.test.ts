import { describe, it, expect } from 'vitest';
import {
  ASSISTANT_ERROR_CODES,
  DEFAULT_ASSISTANT_PREFS,
  DEFAULT_TRANSCRIPT_WINDOW,
  LLM_PRESETS,
  STT_ENGINES,
  countWords,
  isAlwaysOnTopArgs,
  isAssistantErrorCode,
  isAssistantPrefsPatch,
  isExportArgs,
  isLlmKeyArgs,
  isLoopbackHost,
  isOpenAiHost,
  isReasoningEffort,
  isSpeakArgs,
  isValidBaseUrl,
  joinDelta,
  mergeAssistantPrefs,
  resolveAssistantPrefs,
  selectLlmKey,
  speakerOf,
  type StoredAssistantPrefs,
} from '@shared/assistant';

/** Simulates a value read from disk that the type system would not allow. */
const stored = (v: unknown): StoredAssistantPrefs => v as StoredAssistantPrefs;

describe('assistant defaults', () => {
  it('has the spec defaults', () => {
    expect(DEFAULT_ASSISTANT_PREFS).toEqual({
      sttEngine: 'off',
      sttOpenAiModel: 'gpt-4o-mini-transcribe',
      translateInputTranscript: true,
      translateTheirSpeech: true,
      llm: {
        preset: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5-mini',
        reasoningEffort: 'minimal',
      },
      ttsVoice: 'cedar',
      translateVoice: 'cedar',
      ttsModel: 'gpt-4o-mini-tts',
      ttsMonitor: false,
      suggestionsEnabled: true,
      autoSuggest: true,
      transcriptOpenOnLaunch: false,
    });
    expect(DEFAULT_TRANSCRIPT_WINDOW).toEqual({ width: 420, height: 640, alwaysOnTop: false });
    expect(STT_ENGINES).toEqual(['off', 'openai']);
  });

  it('lists all 14 error codes, none of them M7-only', () => {
    expect(ASSISTANT_ERROR_CODES).toHaveLength(14);
    expect(new Set(ASSISTANT_ERROR_CODES).size).toBe(14);
    expect(ASSISTANT_ERROR_CODES).not.toContain('stt-model-download-failed');
    expect(isAssistantErrorCode('llm-auth')).toBe(true);
    expect(isAssistantErrorCode('nope')).toBe(false);
  });
});

describe('resolveAssistantPrefs', () => {
  it('returns defaults for undefined or garbage', () => {
    expect(resolveAssistantPrefs(undefined)).toEqual(DEFAULT_ASSISTANT_PREFS);
    expect(resolveAssistantPrefs(stored('x'))).toEqual(DEFAULT_ASSISTANT_PREFS);
    expect(resolveAssistantPrefs(stored(null))).toEqual(DEFAULT_ASSISTANT_PREFS);
  });

  it('does not share the default llm object', () => {
    const r = resolveAssistantPrefs(undefined);
    r.llm.model = 'changed';
    expect(DEFAULT_ASSISTANT_PREFS.llm.model).toBe('gpt-5-mini');
  });

  it('keeps valid values', () => {
    const r = resolveAssistantPrefs({
      sttEngine: 'openai',
      ttsVoice: 'nova',
      autoSuggest: false,
      llm: { preset: 'ollama', model: 'llama3' },
    });
    expect(r.sttEngine).toBe('openai');
    expect(r.ttsVoice).toBe('nova');
    expect(r.autoSuggest).toBe(false);
    // Missing llm fields fall back to the stored preset's values.
    expect(r.llm).toEqual({
      preset: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'llama3',
      reasoningEffort: 'none',
    });
  });

  it("drops invalid values (incl. a future 'local' engine) and ignores stray keys", () => {
    const r = resolveAssistantPrefs(
      stored({
        sttEngine: 'local',
        whisperModel: 'whisper-small',
        sttOpenAiModel: 'm'.repeat(101),
        ttsVoice: 'Bad Voice!',
        ttsMonitor: 'yes',
        llm: {
          preset: 'nope',
          baseUrl: 'file:///x',
          model: 'm'.repeat(101),
          reasoningEffort: 'extreme',
        },
      }),
    );
    expect(r).toEqual(DEFAULT_ASSISTANT_PREFS);
    expect('whisperModel' in r).toBe(false);
  });

  it('accepts an empty llm model and base URL (LM Studio / custom)', () => {
    const r = resolveAssistantPrefs({ llm: { preset: 'custom', baseUrl: '', model: '' } });
    expect(r.llm).toEqual({ preset: 'custom', baseUrl: '', model: '', reasoningEffort: '' });
  });
});

describe('mergeAssistantPrefs', () => {
  it('deep-merges llm and shallow-merges the rest', () => {
    const base: StoredAssistantPrefs = {
      sttEngine: 'openai',
      llm: { preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'a' },
    };
    const merged = mergeAssistantPrefs(base, { autoSuggest: false, llm: { model: 'b' } });
    expect(merged).toEqual({
      sttEngine: 'openai',
      autoSuggest: false,
      llm: { preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'b' },
    });
    // Inputs untouched.
    expect(base.llm?.model).toBe('a');
  });

  it('handles an undefined or corrupt base', () => {
    expect(mergeAssistantPrefs(undefined, { ttsMonitor: true })).toEqual({ ttsMonitor: true });
    expect(mergeAssistantPrefs(stored('junk'), { llm: { model: 'x' } })).toEqual({
      llm: { model: 'x' },
    });
    expect(mergeAssistantPrefs(stored({ llm: 'junk' }), { llm: { model: 'x' } })).toEqual({
      llm: { model: 'x' },
    });
  });

  it('does not add llm when neither side has it', () => {
    expect('llm' in mergeAssistantPrefs({ sttEngine: 'off' }, { autoSuggest: true })).toBe(false);
  });
});

describe('isAssistantPrefsPatch', () => {
  it('accepts valid patches', () => {
    expect(isAssistantPrefsPatch({})).toBe(true);
    expect(isAssistantPrefsPatch({ sttEngine: 'openai', ttsVoice: 'cedar' })).toBe(true);
    expect(isAssistantPrefsPatch({ llm: { model: '', baseUrl: '' } })).toBe(true);
    expect(
      isAssistantPrefsPatch({
        llm: { preset: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', reasoningEffort: '' },
      }),
    ).toBe(true);
  });

  it('rejects unknown keys at both levels', () => {
    expect(isAssistantPrefsPatch({ whisperModel: 'auto' })).toBe(false);
    expect(isAssistantPrefsPatch({ llm: { apiKey: 'sk-x' } })).toBe(false);
  });

  it('rejects invalid values', () => {
    expect(isAssistantPrefsPatch(null)).toBe(false);
    expect(isAssistantPrefsPatch([])).toBe(false);
    expect(isAssistantPrefsPatch({ sttEngine: 'local' })).toBe(false);
    expect(isAssistantPrefsPatch({ sttEngine: undefined })).toBe(false);
    expect(isAssistantPrefsPatch({ autoSuggest: 'true' })).toBe(false);
    expect(isAssistantPrefsPatch({ ttsVoice: 'UPPER' })).toBe(false);
    expect(isAssistantPrefsPatch({ ttsModel: '' })).toBe(false);
    expect(isAssistantPrefsPatch({ sttOpenAiModel: 'm'.repeat(101) })).toBe(false);
    expect(isAssistantPrefsPatch({ llm: { baseUrl: 'file:///x' } })).toBe(false);
    expect(isAssistantPrefsPatch({ llm: { baseUrl: `https://a.io/${'x'.repeat(200)}` } })).toBe(
      false,
    );
    expect(isAssistantPrefsPatch({ llm: { model: 'm'.repeat(101) } })).toBe(false);
    expect(isAssistantPrefsPatch({ llm: { reasoningEffort: 'max' } })).toBe(false);
    expect(isAssistantPrefsPatch({ llm: { preset: 'anthropic' } })).toBe(false);
    expect(isAssistantPrefsPatch({ llm: 'x' })).toBe(false);
  });
});

describe('IPC argument guards', () => {
  it('isSpeakArgs', () => {
    expect(isSpeakArgs({ text: 'hi', translate: true })).toBe(true);
    expect(isSpeakArgs({ text: 'hi', translate: false, translation: 'oi' })).toBe(true);
    expect(isSpeakArgs({ text: 'hi', translate: false, translation: '' })).toBe(true);
    expect(isSpeakArgs({ text: 'a'.repeat(2000), translate: true })).toBe(true);
    expect(isSpeakArgs({ text: '', translate: true })).toBe(false);
    expect(isSpeakArgs({ text: '   ', translate: true })).toBe(false);
    expect(isSpeakArgs({ text: 'a'.repeat(2001), translate: true })).toBe(false);
    expect(isSpeakArgs({ text: 'hi', translate: 'yes' })).toBe(false);
    expect(isSpeakArgs({ text: 'hi' })).toBe(false);
    expect(isSpeakArgs({ text: 'hi', translate: false, translation: 'a'.repeat(4097) })).toBe(
      false,
    );
    expect(isSpeakArgs({ text: 'hi', translate: false, translation: 3 })).toBe(false);
    expect(isSpeakArgs({ text: 'hi', translate: false, extra: 1 })).toBe(false);
    expect(isSpeakArgs(undefined)).toBe(false);
  });

  it('isExportArgs', () => {
    expect(isExportArgs({ format: 'txt' })).toBe(true);
    expect(isExportArgs({ format: 'md' })).toBe(true);
    expect(isExportArgs({ format: 'pdf' })).toBe(false);
    expect(isExportArgs('txt')).toBe(false);
  });

  it('isLlmKeyArgs', () => {
    expect(isLlmKeyArgs({ value: 'k' })).toBe(true);
    expect(isLlmKeyArgs({ value: 'k'.repeat(300) })).toBe(true);
    expect(isLlmKeyArgs({ value: '' })).toBe(false);
    expect(isLlmKeyArgs({ value: 'k'.repeat(301) })).toBe(false);
    expect(isLlmKeyArgs({ value: 1 })).toBe(false);
  });

  it('isAlwaysOnTopArgs', () => {
    expect(isAlwaysOnTopArgs({ value: true })).toBe(true);
    expect(isAlwaysOnTopArgs({ value: false })).toBe(true);
    expect(isAlwaysOnTopArgs({ value: 1 })).toBe(false);
    expect(isAlwaysOnTopArgs(true)).toBe(false);
  });

  it('isReasoningEffort', () => {
    for (const v of ['', 'none', 'minimal', 'low', 'medium', 'high']) {
      expect(isReasoningEffort(v)).toBe(true);
    }
    expect(isReasoningEffort('xhigh')).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
  });
});

describe('URL and key helpers', () => {
  it('isOpenAiHost', () => {
    expect(isOpenAiHost('https://api.openai.com/v1')).toBe(true);
    expect(isOpenAiHost('https://api.openai.com:443/v1')).toBe(true);
    expect(isOpenAiHost('http://api.openai.com/v1')).toBe(false);
    expect(isOpenAiHost('https://api.openai.com:8443/v1')).toBe(false);
    expect(isOpenAiHost('https://api.openai.com.evil.io')).toBe(false);
    expect(isOpenAiHost('not a url')).toBe(false);
  });

  it('isLoopbackHost', () => {
    expect(isLoopbackHost('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackHost('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLoopbackHost('http://[::1]:1234/v1')).toBe(true);
    expect(isLoopbackHost('http://192.168.1.2:1234/v1')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });

  it('isValidBaseUrl', () => {
    expect(isValidBaseUrl('https://api.openai.com/v1')).toBe(true);
    expect(isValidBaseUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isValidBaseUrl('file:///x')).toBe(false);
    expect(isValidBaseUrl('ftp://x.io')).toBe(false);
    expect(isValidBaseUrl('')).toBe(false);
    expect(isValidBaseUrl(`https://a.io/${'x'.repeat(200)}`)).toBe(false);
  });

  it('selectLlmKey never sends the OpenAI key to a non-OpenAI host', () => {
    expect(selectLlmKey('http://127.0.0.1:11434/v1', 'sk-x', 'k')).toBe('k');
    expect(selectLlmKey('https://api.openai.com/v1', 'sk-x', 'k')).toBe('sk-x');
    expect(selectLlmKey('https://api.openai.com/v1', undefined, 'k')).toBe('k');
    expect(selectLlmKey('http://api.openai.com/v1', 'sk-x', undefined)).toBeUndefined();
    expect(selectLlmKey('https://evil.example/v1', 'sk-x', 'k')).toBe('k');
    expect(selectLlmKey('https://evil.example/v1', 'sk-x', undefined)).toBeUndefined();
  });

  it('presets use 127.0.0.1 for local servers', () => {
    expect(isLoopbackHost(LLM_PRESETS.ollama.baseUrl)).toBe(true);
    expect(LLM_PRESETS.ollama.baseUrl).toContain('127.0.0.1');
    expect(LLM_PRESETS.lmstudio.baseUrl).toContain('127.0.0.1');
    expect(isOpenAiHost(LLM_PRESETS.openai.baseUrl)).toBe(true);
  });
});

describe('text helpers', () => {
  it('speakerOf', () => {
    expect(speakerOf('A')).toBe('me');
    expect(speakerOf('B')).toBe('them');
  });

  it('countWords', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
    expect(countWords('hello')).toBe(1);
    expect(countWords('  hello   world \n again ')).toBe(3);
    expect(countWords('你好世界')).toBe(4);
    expect(countWords('hello 世界')).toBe(3);
    expect(countWords('こんにちは。')).toBe(5);
    expect(countWords('ok — fine')).toBe(2);
  });

  it('joinDelta concatenates token pieces as-is', () => {
    // The real failure: "Per chi ud ere il disc orso".
    const pieces = ['Per', ' chi', ' ud', 'ire', ' il', ' disc', 'orso', ',', ' pot', 'rest', 'i'];
    expect(pieces.reduce(joinDelta, '')).toBe('Per chi udire il discorso, potresti');
    expect(joinDelta('Hello', ' world')).toBe('Hello world');
    expect(joinDelta('Hello ', ' world')).toBe('Hello world');
    expect(joinDelta('', 'world')).toBe('world');
    expect(joinDelta('Hello', '')).toBe('Hello');
    expect(joinDelta('Really', '?')).toBe('Really?');
    expect(joinDelta('你好', '世界')).toBe('你好世界');
  });

  it('joinDelta adds the space a new segment lacks after a sentence end', () => {
    expect(joinDelta('Fine.', 'Next one')).toBe('Fine. Next one');
    expect(joinDelta('Davvero?', 'Sì')).toBe('Davvero? Sì');
    expect(joinDelta('Fine.', ' Next')).toBe('Fine. Next');
    expect(joinDelta('3.', '5')).toBe('3.5');
    expect(joinDelta('好。', '世界')).toBe('好。世界');
  });
});
