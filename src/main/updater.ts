// electron-updater is CommonJS — Node's ESM loader can't statically resolve
// named exports off it, so `import { autoUpdater }` throws "Named export
// 'autoUpdater' not found" at app start. Default-import the module then
// destructure. Type-only import for Logger is erased at runtime so it stays
// a separate `import type` (no CJS interop concerns there).
import electronUpdater from 'electron-updater';
import type { Logger } from 'electron-updater';
import { app } from 'electron';

const { autoUpdater } = electronUpdater;

export interface AutoUpdateHandle {
  /** Trigger a check + auto-download if newer version exists. Errors are logged via the wrapper's logger and never thrown. */
  checkNow: () => Promise<void>;
  /** Quit the app and apply the downloaded update. Caller verifies download is ready first. */
  quitAndInstall: () => void;
}

export interface AutoUpdateOptions {
  onAvailable: (version: string) => void;
  onDownloaded: (version: string) => void;
  logger?: Logger;
}

/** Env var that opts a packaged install into auto-update. Anything other than '1' = off. */
export const AUTO_UPDATE_ENV = 'REALTIME_TRANSLATE_AUTO_UPDATE';

export function setupAutoUpdate(opts: AutoUpdateOptions): AutoUpdateHandle {
  // Skip in dev mode — autoUpdater requires a packaged app and signed metadata.
  // Without this, the dev console gets ~5 ENOENT errors at startup as it
  // looks for app-update.yml that doesn't exist.
  //
  // Also off by default in packaged builds: app-update.yml is generated even with
  // `--publish never` and points at build.publish (the upstream repo), and the NSIS
  // updater installs silently on quit with no signature check for unsigned builds — a
  // newer upstream release would overwrite a locally built/modified install. Opt in
  // with REALTIME_TRANSLATE_AUTO_UPDATE=1. Never for the portable exe: electron-updater
  // has no portable support and would install a separate NSIS copy instead.
  if (
    !app.isPackaged ||
    process.env[AUTO_UPDATE_ENV] !== '1' ||
    process.env.PORTABLE_EXECUTABLE_FILE
  ) {
    return {
      checkNow: async () => undefined,
      quitAndInstall: () => undefined,
    };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (opts.logger) autoUpdater.logger = opts.logger;

  autoUpdater.on('update-available', (info) => {
    opts.onAvailable(info.version);
  });
  autoUpdater.on('update-downloaded', (info) => {
    opts.onDownloaded(info.version);
  });
  autoUpdater.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[updater] error', err.message);
  });

  return {
    checkNow: async () => {
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[updater] checkForUpdates failed', err);
      }
    },
    quitAndInstall: () => {
      autoUpdater.quitAndInstall();
    },
  };
}
