import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { emptyUsage } from '@shared/usage';
import { IPC } from '@shared/events';
import {
  registerAssistantIpcHandlers,
  type AssistantHandlerDeps,
} from '@main/ipc/assistantHandlers';
import { DEFAULT_ASSISTANT_PREFS } from '@shared/assistant';

type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const ASSISTANT_INVOKE_CHANNELS = [
  IPC.OpenTranscriptView,
  IPC.OpenAssistantSettings,
  IPC.TranscriptGet,
  IPC.TranscriptClear,
  IPC.TranscriptExport,
  IPC.TranscriptSetAlwaysOnTop,
  IPC.PrefsSetAssistant,
  IPC.LlmKeyGetHint,
  IPC.LlmKeySet,
  IPC.LlmKeyClear,
  IPC.LlmTest,
  IPC.LlmListModels,
  IPC.SpeakText,
  IPC.SpeakStop,
  IPC.SuggestNow,
  IPC.SuggestionsGet,
  IPC.SttStatusGet,
  IPC.SttRetry,
  IPC.AssistantContextGet,
  IPC.UsageGet,
  IPC.UsageReset,
];

function makeDeps(trusted: { value: boolean }): AssistantHandlerDeps {
  return {
    isTrustedSender: () => trusted.value,
    openTranscriptView: vi.fn(async () => undefined),
    openAssistantSettings: vi.fn(async () => undefined),
    getTranscript: vi.fn(() => []),
    clearTranscript: vi.fn(),
    exportTranscript: vi.fn(async () => ({ saved: true })),
    setTranscriptAlwaysOnTop: vi.fn(),
    setAssistantPrefs: vi.fn(async () => DEFAULT_ASSISTANT_PREFS),
    getLlmKeyHint: vi.fn(() => 'abcd'),
    setLlmKey: vi.fn(),
    clearLlmKey: vi.fn(),
    testLlm: vi.fn(async () => ({ ok: true as const, ms: 12 })),
    listLlmModels: vi.fn(async () => ({ ok: true as const, models: ['m'] })),
    speakText: vi.fn(() => ({ entryId: 'typed-0000abcd' })),
    stopSpeaking: vi.fn(),
    suggestNow: vi.fn(async () => undefined),
    getSuggestions: vi.fn(() => ({ status: 'idle' as const, items: [], updatedAt: 0 })),
    getSttStatus: vi.fn(() => ({ engine: 'off' as const, state: 'off' as const, streams: [] })),
    retryStt: vi.fn(async () => undefined),
    getAssistantContext: vi.fn(() => ({
      langs: { user: 'pt' as const, them: 'en' as const },
      translating: false,
      hasOpenAiKey: true,
      hasToMeetDevice: true,
      setupBusy: false,
    })),
    getUsage: vi.fn(() => emptyUsage(0)),
    resetUsage: vi.fn(() => emptyUsage(5)),
  };
}

describe('registerAssistantIpcHandlers', () => {
  let handlers: Map<string, Handler>;
  let deps: AssistantHandlerDeps;
  const trusted = { value: true };
  const sender = { id: 7 };
  const evt = { sender } as unknown as IpcMainInvokeEvent;
  const call = (channel: string, ...args: unknown[]): unknown => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h(evt, ...args);
  };

  beforeEach(() => {
    handlers = new Map();
    trusted.value = true;
    deps = makeDeps(trusted);
    const ipcMain = {
      handle: (channel: string, h: Handler) => {
        if (handlers.has(channel)) throw new Error(`duplicate ${channel}`);
        handlers.set(channel, h);
      },
    } as unknown as Pick<IpcMain, 'handle'>;
    registerAssistantIpcHandlers(ipcMain, deps);
  });

  it('registers exactly the 21 assistant invoke channels', () => {
    expect(ASSISTANT_INVOKE_CHANNELS).toHaveLength(21);
    expect([...handlers.keys()].sort()).toEqual([...ASSISTANT_INVOKE_CHANNELS].sort());
  });

  it('rejects an untrusted sender before calling any dep', () => {
    trusted.value = false;
    for (const ch of ASSISTANT_INVOKE_CHANNELS) {
      expect(() => call(ch, { value: true })).toThrow(/untrusted sender/);
    }
    expect(deps.speakText).not.toHaveBeenCalled();
    expect(deps.openTranscriptView).not.toHaveBeenCalled();
    expect(deps.clearTranscript).not.toHaveBeenCalled();
    expect(deps.setAssistantPrefs).not.toHaveBeenCalled();
    expect(deps.setLlmKey).not.toHaveBeenCalled();
  });

  it('throws invalid-args for bad arguments without calling the dep', () => {
    expect(() => call(IPC.TranscriptExport, { format: 'pdf' })).toThrow('invalid-args');
    expect(() => call(IPC.TranscriptSetAlwaysOnTop, { value: 'yes' })).toThrow('invalid-args');
    expect(() => call(IPC.PrefsSetAssistant, { whisperModel: 'auto' })).toThrow('invalid-args');
    expect(() => call(IPC.PrefsSetAssistant, { llm: { baseUrl: 'file:///x' } })).toThrow(
      'invalid-args',
    );
    expect(() => call(IPC.LlmKeySet, { value: '' })).toThrow('invalid-args');
    expect(() => call(IPC.SpeakText, { text: '', translate: true })).toThrow('invalid-args');
    expect(() => call(IPC.SpeakText)).toThrow('invalid-args');
    expect(deps.exportTranscript).not.toHaveBeenCalled();
    expect(deps.setTranscriptAlwaysOnTop).not.toHaveBeenCalled();
    expect(deps.setAssistantPrefs).not.toHaveBeenCalled();
    expect(deps.setLlmKey).not.toHaveBeenCalled();
    expect(deps.speakText).not.toHaveBeenCalled();
  });

  it('passes valid arguments through to the deps', async () => {
    await expect(call(IPC.TranscriptExport, { format: 'md' })).resolves.toEqual({ saved: true });
    expect(deps.exportTranscript).toHaveBeenCalledWith('md', sender);

    call(IPC.TranscriptSetAlwaysOnTop, { value: true });
    expect(deps.setTranscriptAlwaysOnTop).toHaveBeenCalledWith(true);

    const patch = { llm: { model: 'qwen3:8b' }, autoSuggest: false };
    await expect(call(IPC.PrefsSetAssistant, patch)).resolves.toEqual(DEFAULT_ASSISTANT_PREFS);
    expect(deps.setAssistantPrefs).toHaveBeenCalledWith(patch);

    call(IPC.LlmKeySet, { value: 'secret-key' });
    expect(deps.setLlmKey).toHaveBeenCalledWith('secret-key');

    const speak = { text: 'hello', translate: false, translation: 'olá' };
    expect(call(IPC.SpeakText, speak)).toEqual({ entryId: 'typed-0000abcd' });
    expect(deps.speakText).toHaveBeenCalledWith(speak);
  });

  it('routes the argument-less channels to their deps', async () => {
    await call(IPC.OpenTranscriptView);
    await call(IPC.OpenAssistantSettings);
    expect(call(IPC.TranscriptGet)).toEqual([]);
    call(IPC.TranscriptClear);
    expect(call(IPC.LlmKeyGetHint)).toBe('abcd');
    call(IPC.LlmKeyClear);
    await expect(call(IPC.LlmTest)).resolves.toEqual({ ok: true, ms: 12 });
    await expect(call(IPC.LlmListModels)).resolves.toEqual({ ok: true, models: ['m'] });
    call(IPC.SpeakStop);
    await call(IPC.SuggestNow);
    expect(call(IPC.SuggestionsGet)).toMatchObject({ status: 'idle' });
    expect(call(IPC.SttStatusGet)).toMatchObject({ engine: 'off', state: 'off' });
    await call(IPC.SttRetry);
    expect(call(IPC.AssistantContextGet)).toMatchObject({ translating: false });

    expect(deps.openTranscriptView).toHaveBeenCalledOnce();
    expect(deps.openAssistantSettings).toHaveBeenCalledOnce();
    expect(deps.clearTranscript).toHaveBeenCalledOnce();
    expect(deps.clearLlmKey).toHaveBeenCalledOnce();
    expect(deps.stopSpeaking).toHaveBeenCalledOnce();
    expect(deps.suggestNow).toHaveBeenCalledOnce();
    expect(deps.retryStt).toHaveBeenCalledOnce();
  });
});
