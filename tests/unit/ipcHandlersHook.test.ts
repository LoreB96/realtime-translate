import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

// handlers.ts registers on the real `ipcMain`; replace it with a collecting fake.
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, h: Handler) => {
      mocks.handlers.set(channel, h);
    },
  },
}));

import { registerIpcHandlers, type HandlerDeps, type PrefsChange } from '@main/ipc/handlers';
import { IPC } from '@shared/events';

const evt = { sender: {} } as unknown as IpcMainInvokeEvent;
const call = (channel: string, ...args: unknown[]): unknown => {
  const h = mocks.handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  return h(evt, ...args);
};

function setup(opts: { failWrites?: boolean; hook?: (what: PrefsChange) => void } = {}): {
  hook: ReturnType<typeof vi.fn>;
  writes: string[];
} {
  mocks.handlers.clear();
  const writes: string[] = [];
  const write = (name: string) => () => {
    if (opts.failWrites) throw new Error(`${name} failed`);
    writes.push(name);
  };
  const hook = vi.fn(opts.hook ?? (() => undefined));
  const deps = {
    configStore: {
      getApiKey: () => undefined,
      setApiKey: write('setApiKey'),
      clearApiKey: write('clearApiKey'),
    },
    prefsStore: {
      load: () => ({}),
      setLanguages: write('setLanguages'),
      setDevices: write('setDevices'),
      setWidgetPosition: write('setWidgetPosition'),
      setUiLanguage: write('setUiLanguage'),
      setMeetConfirmed: write('setMeetConfirmed'),
    },
    isTrustedSender: () => true,
    onPrefsChanged: hook,
  } as unknown as HandlerDeps;
  registerIpcHandlers(deps);
  return { hook, writes };
}

describe('registerIpcHandlers onPrefsChanged hook', () => {
  beforeEach(() => {
    mocks.handlers.clear();
  });

  it('fires once after each of the 4 watched writes, with the right kind', () => {
    const { hook, writes } = setup();
    call(IPC.PrefsSetLanguages, { source: 'pt', target: 'en' });
    expect(hook).toHaveBeenLastCalledWith('languages');
    call(IPC.PrefsSetDevices, { mic: 'm' });
    expect(hook).toHaveBeenLastCalledWith('devices');
    call(IPC.SetApiKey, { value: 'sk-test' });
    expect(hook).toHaveBeenLastCalledWith('apiKey');
    call(IPC.ClearApiKey);
    expect(hook).toHaveBeenLastCalledWith('apiKey');
    expect(hook).toHaveBeenCalledTimes(4);
    expect(writes).toEqual(['setLanguages', 'setDevices', 'setApiKey', 'clearApiKey']);
  });

  it('runs the hook after the write', () => {
    const order: string[] = [];
    const { writes } = setup({ hook: (w) => order.push(`hook:${w}:${writes.length}`) });
    call(IPC.PrefsSetLanguages, { source: 'pt', target: 'en' });
    expect(order).toEqual(['hook:languages:1']);
  });

  it('does not fire when the write throws', () => {
    const { hook } = setup({ failWrites: true });
    expect(() => call(IPC.PrefsSetLanguages, { source: 'pt', target: 'en' })).toThrow();
    expect(() => call(IPC.PrefsSetDevices, {})).toThrow();
    expect(() => call(IPC.SetApiKey, { value: 'x' })).toThrow();
    expect(() => call(IPC.ClearApiKey)).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });

  it('does not fire for other prefs writes', () => {
    const { hook } = setup();
    call(IPC.PrefsSetWidgetPosition, { x: 1, y: 2 });
    call(IPC.PrefsSetUiLanguage, 'en-US');
    call(IPC.PrefsSetMeetConfirmed, true);
    expect(hook).not.toHaveBeenCalled();
  });

  it('keeps the return value and ignores hook failures', () => {
    setup({
      hook: () => {
        throw new Error('hook bug');
      },
    });
    expect(call(IPC.SetApiKey, { value: 'x' })).toBeUndefined();
  });

  it('works without a hook', () => {
    mocks.handlers.clear();
    const deps = {
      configStore: { setApiKey: () => undefined },
      prefsStore: {},
      isTrustedSender: () => true,
    } as unknown as HandlerDeps;
    registerIpcHandlers(deps);
    expect(() => call(IPC.SetApiKey, { value: 'x' })).not.toThrow();
  });
});
