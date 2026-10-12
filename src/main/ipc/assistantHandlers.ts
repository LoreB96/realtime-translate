/**
 * IPC handlers of the call assistant (M6, spec §8). Separate from handlers.ts so the
 * assistant surface can be wired (U11c) and tested on its own: the caller injects
 * `ipcMain`, so this module has only type imports from Electron.
 */
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { IPC } from '../../shared/events';
import {
  isAlwaysOnTopArgs,
  isAssistantPrefsPatch,
  isExportArgs,
  isLlmKeyArgs,
  isSpeakArgs,
  type AssistantContext,
  type AssistantPrefs,
  type AssistantPrefsPatch,
  type SpeakArgs,
  type SttStatus,
  type SuggestionsState,
  type TranscriptEntry,
} from '../../shared/assistant';
import type { UsageSnapshot } from '../../shared/usage';
import type { IpcInvokeMap, LlmModelsResult, LlmTestResult } from './channels';

export type { LlmModelsResult, LlmTestResult } from './channels';

export interface AssistantHandlerDeps {
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
  openTranscriptView: () => Promise<void>;
  openAssistantSettings: () => Promise<void>;
  getTranscript: () => TranscriptEntry[];
  clearTranscript: () => void;
  exportTranscript: (format: 'txt' | 'md', sender: WebContents) => Promise<{ saved: boolean }>;
  setTranscriptAlwaysOnTop: (value: boolean) => void;
  setAssistantPrefs: (patch: AssistantPrefsPatch) => Promise<AssistantPrefs>;
  getLlmKeyHint: () => string | undefined;
  setLlmKey: (value: string) => void;
  clearLlmKey: () => void;
  testLlm: () => Promise<LlmTestResult>;
  listLlmModels: () => Promise<LlmModelsResult>;
  speakText: (a: SpeakArgs) => { entryId: string };
  stopSpeaking: () => void;
  suggestNow: () => Promise<void>;
  getSuggestions: () => SuggestionsState;
  getSttStatus: () => SttStatus;
  retryStt: () => Promise<void>;
  getAssistantContext: () => AssistantContext;
  getUsage: () => UsageSnapshot;
  resetUsage: () => UsageSnapshot;
}

type InvokeHandler<K extends keyof IpcInvokeMap> = (
  e: IpcMainInvokeEvent,
  args: unknown,
) => Promise<IpcInvokeMap[K]['result']> | IpcInvokeMap[K]['result'];

function invalidArgs(): Error {
  return new Error('invalid-args');
}

export function registerAssistantIpcHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: AssistantHandlerDeps,
): void {
  // Same shape as handlers.ts: trusted-sender check first, then the handler. Args arrive
  // as `unknown` here: every handler with arguments validates them with a guard.
  const handle = <K extends keyof IpcInvokeMap>(channel: K, handler: InvokeHandler<K>): void => {
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      if (!deps.isTrustedSender(e)) throw new Error(`untrusted sender for ${channel}`);
      return handler(e, args[0]);
    });
  };

  handle(IPC.OpenTranscriptView, () => deps.openTranscriptView());
  handle(IPC.OpenAssistantSettings, () => deps.openAssistantSettings());
  handle(IPC.TranscriptGet, () => deps.getTranscript());
  handle(IPC.TranscriptClear, () => deps.clearTranscript());
  handle(IPC.TranscriptExport, (e, args) => {
    if (!isExportArgs(args)) throw invalidArgs();
    return deps.exportTranscript(args.format, e.sender);
  });
  handle(IPC.TranscriptSetAlwaysOnTop, (_e, args) => {
    if (!isAlwaysOnTopArgs(args)) throw invalidArgs();
    deps.setTranscriptAlwaysOnTop(args.value);
  });
  handle(IPC.PrefsSetAssistant, (_e, args) => {
    if (!isAssistantPrefsPatch(args)) throw invalidArgs();
    return deps.setAssistantPrefs(args);
  });
  handle(IPC.LlmKeyGetHint, () => deps.getLlmKeyHint());
  handle(IPC.LlmKeySet, (_e, args) => {
    if (!isLlmKeyArgs(args)) throw invalidArgs();
    deps.setLlmKey(args.value);
  });
  handle(IPC.LlmKeyClear, () => deps.clearLlmKey());
  handle(IPC.LlmTest, () => deps.testLlm());
  handle(IPC.LlmListModels, () => deps.listLlmModels());
  handle(IPC.SpeakText, (_e, args) => {
    if (!isSpeakArgs(args)) throw invalidArgs();
    return deps.speakText(args);
  });
  handle(IPC.SpeakStop, () => deps.stopSpeaking());
  handle(IPC.SuggestNow, () => deps.suggestNow());
  handle(IPC.SuggestionsGet, () => deps.getSuggestions());
  handle(IPC.SttStatusGet, () => deps.getSttStatus());
  handle(IPC.SttRetry, () => deps.retryStt());
  handle(IPC.AssistantContextGet, () => deps.getAssistantContext());
  handle(IPC.UsageGet, () => deps.getUsage());
  handle(IPC.UsageReset, () => deps.resetUsage());
}
