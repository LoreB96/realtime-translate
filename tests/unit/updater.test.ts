import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted lets us define mock state above the hoisted vi.mock() factories
// so the factories can capture references without TDZ errors.
const mocks = vi.hoisted(() => {
  const state = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
  };
  return {
    state,
    onMock: vi.fn(),
    checkForUpdatesMock: vi.fn().mockResolvedValue(undefined),
    quitAndInstallMock: vi.fn(),
  };
});

// Mock electron's app — must mock before importing setupAutoUpdate.
vi.mock('electron', () => ({
  app: { isPackaged: true },
}));

// electron-updater is CJS — production code default-imports it then
// destructures. Mock matches that shape: the default export is the module
// object containing autoUpdater.
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      set autoDownload(v: boolean) {
        mocks.state.autoDownload = v;
      },
      set autoInstallOnAppQuit(v: boolean) {
        mocks.state.autoInstallOnAppQuit = v;
      },
      on: mocks.onMock,
      checkForUpdates: mocks.checkForUpdatesMock,
      quitAndInstall: mocks.quitAndInstallMock,
      logger: undefined,
    },
  },
}));

import { setupAutoUpdate, AUTO_UPDATE_ENV } from '@main/updater';

describe('setupAutoUpdate', () => {
  beforeEach(() => {
    mocks.onMock.mockClear();
    mocks.checkForUpdatesMock.mockClear();
    mocks.quitAndInstallMock.mockClear();
    mocks.state.autoDownload = false;
    mocks.state.autoInstallOnAppQuit = false;
    process.env[AUTO_UPDATE_ENV] = '1';
    delete process.env.PORTABLE_EXECUTABLE_FILE;
  });

  afterEach(() => {
    delete process.env[AUTO_UPDATE_ENV];
    delete process.env.PORTABLE_EXECUTABLE_FILE;
  });

  it('is a no-op by default so a local build is never overwritten', async () => {
    delete process.env[AUTO_UPDATE_ENV];
    const handle = setupAutoUpdate({ onAvailable: () => undefined, onDownloaded: () => undefined });
    await handle.checkNow();
    handle.quitAndInstall();
    expect(mocks.onMock).not.toHaveBeenCalled();
    expect(mocks.checkForUpdatesMock).not.toHaveBeenCalled();
    expect(mocks.quitAndInstallMock).not.toHaveBeenCalled();
    expect(mocks.state.autoDownload).toBe(false);
    expect(mocks.state.autoInstallOnAppQuit).toBe(false);
  });

  it('is a no-op in the portable exe even when opted in', async () => {
    process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\tmp\\Realtime Translate 0.5.0-m5.exe';
    const handle = setupAutoUpdate({ onAvailable: () => undefined, onDownloaded: () => undefined });
    await handle.checkNow();
    expect(mocks.onMock).not.toHaveBeenCalled();
    expect(mocks.checkForUpdatesMock).not.toHaveBeenCalled();
  });

  it('registers update-available, update-downloaded, error listeners', () => {
    setupAutoUpdate({ onAvailable: () => undefined, onDownloaded: () => undefined });
    const events = mocks.onMock.mock.calls.map((c) => c[0]);
    expect(events).toContain('update-available');
    expect(events).toContain('update-downloaded');
    expect(events).toContain('error');
  });

  it('forwards version to onAvailable callback', () => {
    const onAvailable = vi.fn();
    setupAutoUpdate({ onAvailable, onDownloaded: () => undefined });
    const availCall = mocks.onMock.mock.calls.find((c) => c[0] === 'update-available');
    if (!availCall) throw new Error('no update-available listener');
    const handler = availCall[1] as (info: { version: string }) => void;
    handler({ version: '0.5.1' });
    expect(onAvailable).toHaveBeenCalledWith('0.5.1');
  });

  it('forwards version to onDownloaded callback', () => {
    const onDownloaded = vi.fn();
    setupAutoUpdate({ onAvailable: () => undefined, onDownloaded });
    const dlCall = mocks.onMock.mock.calls.find((c) => c[0] === 'update-downloaded');
    if (!dlCall) throw new Error('no update-downloaded listener');
    const handler = dlCall[1] as (info: { version: string }) => void;
    handler({ version: '0.5.2' });
    expect(onDownloaded).toHaveBeenCalledWith('0.5.2');
  });

  it('checkNow calls autoUpdater.checkForUpdates', async () => {
    const handle = setupAutoUpdate({
      onAvailable: () => undefined,
      onDownloaded: () => undefined,
    });
    await handle.checkNow();
    expect(mocks.checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it('quitAndInstall calls autoUpdater.quitAndInstall', () => {
    const handle = setupAutoUpdate({
      onAvailable: () => undefined,
      onDownloaded: () => undefined,
    });
    handle.quitAndInstall();
    expect(mocks.quitAndInstallMock).toHaveBeenCalledTimes(1);
  });

  it('configures autoDownload and autoInstallOnAppQuit', () => {
    setupAutoUpdate({ onAvailable: () => undefined, onDownloaded: () => undefined });
    expect(mocks.state.autoDownload).toBe(true);
    expect(mocks.state.autoInstallOnAppQuit).toBe(true);
  });
});

describe('setupAutoUpdate in dev mode', () => {
  it('returns no-op handle when app is not packaged', async () => {
    vi.resetModules();
    vi.doMock('electron', () => ({ app: { isPackaged: false } }));
    // Opted in, so only the isPackaged gate can make this a no-op.
    process.env.REALTIME_TRANSLATE_AUTO_UPDATE = '1';
    try {
      mocks.onMock.mockClear();
      mocks.checkForUpdatesMock.mockClear();
      const { setupAutoUpdate: setupDev } = await import('@main/updater');
      const handle = setupDev({ onAvailable: () => undefined, onDownloaded: () => undefined });
      await handle.checkNow(); // no-op, doesn't throw
      handle.quitAndInstall(); // no-op
      expect(mocks.onMock).not.toHaveBeenCalled();
      expect(mocks.checkForUpdatesMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.REALTIME_TRANSLATE_AUTO_UPDATE;
    }
  });
});
