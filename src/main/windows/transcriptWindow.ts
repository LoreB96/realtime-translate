/**
 * Transcript window (M6): a singleton BrowserWindow showing the live call transcript, typed
 * speech and reply suggestions. Bounds and always-on-top persist through the injected prefs
 * callbacks; restored bounds are clamped so the window is always reachable. No quit logic here:
 * app.ts decides what closing it means.
 */
import { BrowserWindow, screen } from 'electron';
import type { TranscriptWindowPrefs } from '../../shared/assistant';
import { clampBoundsToDisplays } from './windowBounds';

export interface TranscriptWindowDeps {
  url: string;
  preloadPath: string;
  /** Stored prefs, or DEFAULT_TRANSCRIPT_WINDOW. */
  loadPrefs: () => TranscriptWindowPrefs;
  savePrefs: (p: Partial<TranscriptWindowPrefs>) => void;
  /** Navigation guard + external-link handler. */
  attachGuards: (w: BrowserWindow) => void;
}

export interface TranscriptWindowController {
  /** Singleton: focuses (and restores) the window when it is already open. */
  open(): Promise<void>;
  get(): BrowserWindow | undefined;
  /** Persists the value and applies it at level 'floating' when the window is open. */
  setAlwaysOnTop(value: boolean): void;
  close(): void;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 360;
const SAVE_BOUNDS_DEBOUNCE_MS = 300;

export function createTranscriptWindowController(
  deps: TranscriptWindowDeps,
): TranscriptWindowController {
  let win: BrowserWindow | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const alive = (): BrowserWindow | undefined => (win && !win.isDestroyed() ? win : undefined);

  const flushBounds = (w: BrowserWindow): void => {
    if (w.isDestroyed() || w.isMinimized() || w.isMaximized() || w.isFullScreen()) return;
    const { x, y, width, height } = w.getBounds();
    deps.savePrefs({ x, y, width, height });
  };

  const scheduleSaveBounds = (w: BrowserWindow): void => {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      flushBounds(w);
    }, SAVE_BOUNDS_DEBOUNCE_MS);
  };

  const open = async (): Promise<void> => {
    const existing = alive();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      if (!existing.isVisible()) existing.show();
      existing.focus();
      return;
    }

    const prefs = deps.loadPrefs();
    const bounds = clampBoundsToDisplays(
      {
        ...(prefs.x !== undefined ? { x: prefs.x } : {}),
        ...(prefs.y !== undefined ? { y: prefs.y } : {}),
        width: Math.max(MIN_WIDTH, prefs.width),
        height: Math.max(MIN_HEIGHT, prefs.height),
      },
      screen.getAllDisplays().map((d) => d.workArea),
      screen.getPrimaryDisplay().workArea,
    );

    const w = new BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      backgroundColor: '#08090a',
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // Keep timers and IPC on time while another app is in front.
        backgroundThrottling: false,
      },
    });
    // Reference assigned before loadURL so a second open() during load focuses this window.
    win = w;
    if (prefs.alwaysOnTop) w.setAlwaysOnTop(true, 'floating');

    w.once('ready-to-show', () => {
      if (!w.isDestroyed()) w.show();
    });
    w.on('moved', () => scheduleSaveBounds(w));
    w.on('resized', () => scheduleSaveBounds(w));
    w.on('close', () => {
      // Persist the final bounds immediately instead of losing a pending debounce.
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
        flushBounds(w);
      }
    });
    w.on('closed', () => {
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      if (win === w) win = undefined;
    });

    deps.attachGuards(w);
    await w.loadURL(deps.url);
  };

  return {
    open,
    get: alive,
    setAlwaysOnTop(value: boolean): void {
      deps.savePrefs({ alwaysOnTop: value });
      const w = alive();
      if (!w) return;
      if (value) w.setAlwaysOnTop(true, 'floating');
      else w.setAlwaysOnTop(false);
    },
    close(): void {
      alive()?.close();
    },
  };
}
