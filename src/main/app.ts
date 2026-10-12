import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerSaveBlocker,
  safeStorage,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type WebContents,
} from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { registerIpcHandlers } from './ipc/handlers';
import { registerAssistantIpcHandlers } from './ipc/assistantHandlers';
import { AssistantRuntime, type AssistantAudioState } from './assistant/assistantRuntime';
import { UsageMeter } from './usage/usageMeter';
import { createTranscriptWindowController } from './windows/transcriptWindow';
import { nodeFetch } from './util/fetchLike';
import { validateExternalUrl } from './ipc/openExternalUrl';
import { setupAutoUpdate } from './updater';
import { type WebSocketLike, type WebSocketFactory } from './translate/openaiSession';
import { type OffscreenController } from './translate/audioPipeline';
import { SessionManager } from './translate/sessionManager';
import { TestSessionRegistry } from './translate/testSession';
import { runLoopback } from './audio/loopbackCapture';
import {
  Passthrough,
  PASSTHROUGH_A,
  PASSTHROUGH_B,
  type PassthroughOffscreen,
} from './audio/passthrough';
import { detectVirtualCables, type DeviceInfo } from './audio/deviceDetector';
import { reconcileDevices } from './audio/deviceReconcile';
import {
  HealthMonitor,
  findMissingRoles,
  outputStreamKey,
  presentDeviceIds,
} from './health/healthMonitor';
import { runDiagnostics } from './health/diagnostics';
import { createLogger, LogLevel } from './util/logger';
import { atomicWriteFileSync } from './util/atomicWrite';
import { ExponentialBackoff } from './util/retryPolicy';
import { JsonlSink } from './util/jsonlSink';
import { ConfigStore } from './config/configStore';
import { UserPrefsStore } from './config/userPrefsStore';
import { readEnvApiKey } from './config/envFallback';
import { resolveLocale } from './i18n/resolveLocale';
import { createT, getDictionary } from '../shared/i18n';
import { IPC } from '../shared/events';
import { DEFAULT_TRANSCRIPT_WINDOW, type SttStatus } from '../shared/assistant';
import {
  OFFSCREEN_IPC,
  isLevelReport,
  isStreamEvent,
  type InputMeasurement,
  type LevelReport,
  type PlaybackOptions,
  type StreamEvent,
  type TapMode,
  type TapOptions,
} from '../shared/offscreenContract';
import type {
  BidirectionalArgs,
  DeviceInventory,
  DeviceRole,
  DeviceSummary,
  Direction,
  DirectionalState,
  HealthReport,
} from '../shared/types';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEV_BASE = process.env.ELECTRON_RENDERER_URL;
const FLOATING_WIDGET_URL = DEV_BASE
  ? `${DEV_BASE.replace(/\/$/, '')}/floating-widget.html`
  : `file://${resolve(__dirname, '../renderer/floating-widget.html')}`;
const SETUP_VIEW_URL = DEV_BASE
  ? `${DEV_BASE.replace(/\/$/, '')}/setup-view.html`
  : `file://${resolve(__dirname, '../renderer/setup-view.html')}`;
const OFFSCREEN_URL = DEV_BASE
  ? `${DEV_BASE.replace(/\/$/, '')}/offscreen.html`
  : `file://${resolve(__dirname, '../renderer/offscreen.html')}`;
const TRANSCRIPT_URL = DEV_BASE
  ? `${DEV_BASE.replace(/\/$/, '')}/transcript.html`
  : `file://${resolve(__dirname, '../renderer/transcript.html')}`;
/** Preload of every UI window (bar, setup, transcript): exposes window.rt. */
const UI_PRELOAD_PATH = join(__dirname, '../preload/preload.cjs');

/** Directory the production renderer HTML is loaded from. */
const RENDERER_DIR = resolve(__dirname, '../renderer');

/**
 * True for URLs of our own renderer pages (dev server origin, or a file inside the
 * packaged renderer directory). Used to keep the privileged preload (window.rt) away from
 * anything else a window might navigate to.
 */
function isAppUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (DEV_BASE) {
    try {
      return url.origin === new URL(DEV_BASE).origin;
    } catch {
      return false;
    }
  }
  if (url.protocol !== 'file:') return false;
  try {
    const path = fileURLToPath(url).toLowerCase();
    const root = RENDERER_DIR.toLowerCase();
    return path === root || path.startsWith(root + sep);
  } catch {
    return false;
  }
}

let floatingWidget: BrowserWindow | null = null;
let setupView: BrowserWindow | null = null;
let offscreenWindow: BrowserWindow | null = null;
let logSink: JsonlSink | undefined;
/** Route (location.hash) the setup window is showing, e.g. '#/troubleshoot'. */
let setupHash = '';
/** Set once the app is ready; re-evaluates the untranslated passthrough. */
let onSetupViewChanged: () => void = () => undefined;

/**
 * The hidden offscreen window keeps 'window-all-closed' from ever firing, so closing the
 * last VISIBLE window must quit explicitly — otherwise the process lingers with no UI
 * while passthrough keeps routing the mic into the call (or a session keeps billing).
 */
function quitIfNoVisibleWindow(): void {
  const alive = (w: BrowserWindow | null): boolean => Boolean(w && !w.isDestroyed());
  if (!alive(floatingWidget) && !alive(setupView)) app.quit();
}

/** Blocks navigation away from our renderer pages (the preload exposes window.rt). */
function attachNavigationGuard(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      // eslint-disable-next-line no-console
      console.warn('[navigation] blocked', { url });
    }
  });
}

const wsFactory: WebSocketFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers });
  const handle: WebSocketLike & {
    onopen?: () => void;
    onclose?: (c: number, r: string) => void;
    onmessage?: (d: string) => void;
    onerror?: (e: Error) => void;
  } = {
    get readyState() {
      return ws.readyState;
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  };
  ws.on('open', () => handle.onopen?.());
  ws.on('close', (c, r) => handle.onclose?.(c, r.toString()));
  ws.on('message', (d) => handle.onmessage?.(d.toString()));
  ws.on('error', (e) => handle.onerror?.(e));
  return handle;
};

/** Rejects after `ms` so a hung offscreen renderer can't block the serialized lifecycle forever. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Upper bound for opening a device in the offscreen renderer (getUserMedia + setSinkId). */
const OPEN_TIMEOUT_MS = 15_000;
/** Slack added on top of a diagnostics measurement / tone duration. */
const DIAG_TIMEOUT_SLACK_MS = 5_000;

const J = (v: unknown): string => JSON.stringify(v);

const isPcmPayload = (v: unknown): v is { streamId: string; base64: string } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { streamId?: unknown }).streamId === 'string' &&
  typeof (v as { base64?: unknown }).base64 === 'string';

const isInputMeasurement = (v: unknown): v is InputMeasurement =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { maxRmsDb?: unknown }).maxRmsDb === 'number' &&
  typeof (v as { digitalSilence?: unknown }).digitalSilence === 'boolean';

interface OffscreenSignals {
  onLevel(r: LevelReport): void;
  onStreamEvent(e: StreamEvent): void;
  onDeviceChange(): void;
}

class OffscreenBridge implements OffscreenController, PassthroughOffscreen {
  private pcmCallbacks = new Map<string, (b64: string) => void>();
  /**
   * Assistant STT taps on passthrough streams (M6). Kept apart from pcmCallbacks: stopStream
   * (a passthrough restart) must not drop a tap — SttService owns its lifetime via setTap.
   */
  private tapCallbacks = new Map<string, (b64: string) => void>();
  /** Captured once: BrowserWindow.webContents throws after the window is destroyed. */
  private readonly contents: Electron.WebContents;
  private readonly listeners: [string, (e: IpcMainEvent, payload: unknown) => void][];

  constructor(
    private readonly window: BrowserWindow,
    signals: OffscreenSignals,
  ) {
    this.contents = window.webContents;
    // Only the offscreen window may feed these channels: any other renderer (bar, setup)
    // could otherwise inject fake PCM into a paid session or forge health signals.
    const fromOffscreen = (e: IpcMainEvent): boolean =>
      !this.contents.isDestroyed() && e.sender === this.contents;
    this.listeners = [
      [OFFSCREEN_IPC.Pcm, (e, payload) => {
        if (!fromOffscreen(e) || !isPcmPayload(payload)) return;
        (this.pcmCallbacks.get(payload.streamId) ?? this.tapCallbacks.get(payload.streamId))?.(
          payload.base64,
        );
      }],
      [OFFSCREEN_IPC.Level, (e, payload) => {
        if (fromOffscreen(e) && isLevelReport(payload)) signals.onLevel(payload);
      }],
      [OFFSCREEN_IPC.StreamEvent, (e, payload) => {
        if (fromOffscreen(e) && isStreamEvent(payload)) signals.onStreamEvent(payload);
      }],
      [OFFSCREEN_IPC.DeviceChange, (e) => {
        if (fromOffscreen(e)) signals.onDeviceChange();
      }],
    ];
    for (const [channel, fn] of this.listeners) ipcMain.on(channel, fn);
  }

  dispose(): void {
    for (const [channel, fn] of this.listeners) ipcMain.removeListener(channel, fn);
    this.pcmCallbacks.clear();
    this.tapCallbacks.clear();
  }

  private isAlive(): boolean {
    return !this.window.isDestroyed() && !this.contents.isDestroyed();
  }

  private exec<T>(code: string, timeoutMs: number, label: string): Promise<T> {
    const run = (this.contents.executeJavaScript(code) as Promise<T>).catch((err: unknown) => {
      // Defense in depth: the offscreen API already rejects with plain Errors, but a
      // non-Error rejection would otherwise surface as "[object Object]" in logs/UI.
      if (err instanceof Error) throw err;
      const o = err as { name?: unknown; message?: unknown } | null;
      const text =
        o && typeof o === 'object' && (typeof o.message === 'string' || typeof o.name === 'string')
          ? [o.name, o.message].filter((x) => typeof x === 'string' && x).join(': ')
          : String(err);
      throw new Error(`${label}: ${text}`);
    });
    return withTimeout(run, timeoutMs, label);
  }

  async startCapture(
    streamId: string,
    deviceId: string,
    onPcm: (b64: string) => void,
  ): Promise<void> {
    this.pcmCallbacks.set(streamId, onPcm);
    if (!this.isAlive()) return;
    await this.exec(
      `window.offscreen.startCapture(${JSON.stringify(streamId)}, ${JSON.stringify(deviceId)})`,
      OPEN_TIMEOUT_MS,
      'startCapture',
    );
  }
  async startPlayback(streamId: string, deviceId: string): Promise<void> {
    if (!this.isAlive()) return;
    await this.exec(
      `window.offscreen.startPlayback(${JSON.stringify(streamId)}, ${JSON.stringify(deviceId)})`,
      OPEN_TIMEOUT_MS,
      'startPlayback',
    );
  }
  async startPassthrough(streamId: string, inputId: string, outputId: string): Promise<void> {
    if (!this.isAlive()) return;
    await this.exec(
      `window.offscreen.startPassthrough(${JSON.stringify(streamId)}, ${JSON.stringify(inputId)}, ${JSON.stringify(outputId)})`,
      OPEN_TIMEOUT_MS,
      'startPassthrough',
    );
  }
  async measureInput(deviceId: string, ms: number): Promise<InputMeasurement> {
    if (!this.isAlive()) throw new Error('offscreen window unavailable');
    const result = await this.exec<unknown>(
      `window.offscreen.measureInput(${JSON.stringify(deviceId)}, ${JSON.stringify(ms)})`,
      ms + DIAG_TIMEOUT_SLACK_MS,
      'measureInput',
    );
    if (!isInputMeasurement(result)) throw new Error('measureInput returned an invalid result');
    return { maxRmsDb: result.maxRmsDb, digitalSilence: result.digitalSilence };
  }
  async playTone(deviceId: string, ms: number, frequencyHz: number, gainDb?: number): Promise<void> {
    if (!this.isAlive()) throw new Error('offscreen window unavailable');
    const gainArg = gainDb === undefined ? '' : `, ${JSON.stringify(gainDb)}`;
    await this.exec(
      `window.offscreen.playTone(${JSON.stringify(deviceId)}, ${JSON.stringify(ms)}, ${JSON.stringify(frequencyHz)}${gainArg})`,
      ms + DIAG_TIMEOUT_SLACK_MS,
      'playTone',
    );
  }
  /** Assistant STT tap on a passthrough stream; PCM arrives on the existing Pcm channel. */
  async setTap(
    streamId: string,
    mode: TapMode,
    opts?: TapOptions,
    onPcm?: (b64: string) => void,
  ): Promise<void> {
    if (mode === 'main24k' && onPcm) this.tapCallbacks.set(streamId, onPcm);
    else this.tapCallbacks.delete(streamId);
    if (!this.isAlive()) return;
    await this.exec(
      `window.offscreen.setPassthroughTap(${J(streamId)}, ${J(mode)}, ${J(opts ?? {})})`,
      OPEN_TIMEOUT_MS,
      'setPassthroughTap',
    );
  }
  async startPlaybackWithOptions(
    streamId: string,
    deviceId: string,
    opts: PlaybackOptions,
  ): Promise<void> {
    if (!this.isAlive()) return;
    await this.exec(
      `window.offscreen.startPlaybackWithOptions(${J(streamId)}, ${J(deviceId)}, ${J(opts)})`,
      OPEN_TIMEOUT_MS,
      'startPlaybackWithOptions',
    );
  }
  pushPlayback(streamId: string, b64: string): void {
    if (!this.isAlive()) return;
    this.contents.send(OFFSCREEN_IPC.PushPlayback, { streamId, base64: b64 });
  }
  stopStream(streamId: string): void {
    this.pcmCallbacks.delete(streamId);
    if (!this.isAlive()) return;
    this.contents
      .executeJavaScript(`window.offscreen.stopStream(${JSON.stringify(streamId)})`)
      .catch(() => undefined);
  }
  stopAll(): void {
    this.pcmCallbacks.clear();
    this.tapCallbacks.clear();
    if (!this.isAlive()) return;
    this.contents
      .executeJavaScript('window.offscreen.stopAll()')
      .catch(() => undefined);
  }
}

/**
 * setWindowOpenHandler closure used on every BrowserWindow that loads renderer
 * HTML. Defense-in-depth: any window.open / target=_blank attempt is denied
 * and redirected through validateExternalUrl + shell.openExternal so it lands
 * in the user's default browser instead of an in-app BrowserWindow with no
 * chrome. Most call sites already use the typed IPC; this catches legacy HTML
 * or future contributors who miss it. Exempt: offscreenWindow (no user content).
 */
function attachExternalLinkHandler(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = validateExternalUrl(url);
      void shell.openExternal(parsed.toString());
    } catch (err) {
      // Log so a malformed URL or unexpected protocol surfaces in dev — most
      // common cause is a renderer bug that didn't go through the typed IPC.
      // eslint-disable-next-line no-console
      console.warn('[external-link] blocked window-open', { url, error: (err as Error).message });
    }
    return { action: 'deny' };
  });
}

function toDeviceSummary(d: DeviceInfo): DeviceSummary {
  return { deviceId: d.deviceId, label: d.label, kind: d.kind };
}

async function buildDeviceInventory(window: BrowserWindow): Promise<DeviceInventory> {
  const raw: { deviceId: string; label: string; kind: string }[] = await withTimeout(
    window.webContents.executeJavaScript('window.offscreen.listDevices()'),
    10_000,
    'listDevices',
  );
  const typed: DeviceInfo[] = raw.map((d) => ({
    deviceId: d.deviceId,
    label: d.label,
    kind: d.kind as 'audioinput' | 'audiooutput',
  }));
  const detection = detectVirtualCables(typed);
  const inventory: DeviceInventory = {
    inputs: detection.realDevices.inputs.map(toDeviceSummary),
    outputs: detection.realDevices.outputs.map(toDeviceSummary),
  };
  if (detection.cableA) {
    inventory.cableA = {
      ...(detection.cableA.playback ? { playback: toDeviceSummary(detection.cableA.playback) } : {}),
      ...(detection.cableA.recording ? { recording: toDeviceSummary(detection.cableA.recording) } : {}),
    };
  }
  if (detection.cableB) {
    inventory.cableB = {
      ...(detection.cableB.playback ? { playback: toDeviceSummary(detection.cableB.playback) } : {}),
      ...(detection.cableB.recording ? { recording: toDeviceSummary(detection.cableB.recording) } : {}),
    };
  }
  return inventory;
}

function computeWidgetPosition(
  preferred: { x: number; y: number } | undefined,
  windowWidth: number,
  windowHeight: number,
): { x: number; y: number } {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  // If preferred is on-screen, use it.
  if (preferred) {
    const onScreen = screen.getAllDisplays().some((d) => {
      const w = d.workArea;
      return preferred.x >= w.x && preferred.y >= w.y &&
        preferred.x + windowWidth <= w.x + w.width &&
        preferred.y + windowHeight <= w.y + w.height;
    });
    if (onScreen) return preferred;
  }
  // Default: centered horizontally, 4px above the taskbar (workArea bottom).
  return {
    x: wa.x + Math.round((wa.width - windowWidth) / 2),
    y: wa.y + wa.height - windowHeight - 4,
  };
}

function isSetupComplete(configStore: ConfigStore, prefsStore: UserPrefsStore): boolean {
  // Setup is complete iff API key is stored AND all 4 devices are remembered.
  const hasKey = configStore.getApiKey() !== undefined;
  if (!hasKey) return false;
  const prefs = prefsStore.load();
  const d = prefs.devices;
  return Boolean(d?.mic && d?.toMeet && d?.fromMeet && d?.headset);
}

/** Bar window size: room for the health chip, the service toggles and the cost chip. */
const WIDGET_WIDTH = 640;
const WIDGET_HEIGHT = 40;
/** Window height while the control panel (services + spend) is open above/below the bar. */
const WIDGET_EXPANDED_HEIGHT = 410;
/** Where the open panel grew the bar window; undefined while collapsed. */
let barExpand: { direction: 'up' | 'down' } | undefined;

/**
 * Opens/closes the bar's control panel by growing the window. It grows upwards (the bar
 * normally sits above the taskbar) unless there is no room above, then downwards; the bar
 * itself never moves on screen.
 */
function setBarExpanded(expanded: boolean): { direction: 'up' | 'down' } {
  const win = floatingWidget;
  if (!win || win.isDestroyed()) return { direction: 'up' };
  const [x = 0, y = 0] = win.getPosition();
  const extra = WIDGET_EXPANDED_HEIGHT - WIDGET_HEIGHT;
  if (expanded) {
    if (barExpand) return barExpand;
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const direction = y - extra >= wa.y ? 'up' : 'down';
    // Set before moving: the 'moved' handler maps the window back to the bar position.
    barExpand = { direction };
    win.setBounds({
      x,
      y: direction === 'up' ? y - extra : y,
      width: WIDGET_WIDTH,
      height: WIDGET_EXPANDED_HEIGHT,
    });
    return barExpand;
  }
  const was = barExpand;
  if (!was) return { direction: 'up' };
  barExpand = undefined;
  win.setBounds({
    x,
    y: was.direction === 'up' ? y + extra : y,
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
  });
  return was;
}

async function createFloatingWidget(prefsStore: UserPrefsStore): Promise<BrowserWindow> {
  if (floatingWidget && !floatingWidget.isDestroyed()) {
    floatingWidget.focus();
    return floatingWidget;
  }
  const win = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: UI_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep timers and IPC on time while another app is in front.
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  attachExternalLinkHandler(win);
  attachNavigationGuard(win);

  const stored = prefsStore.load().widgetPosition;
  const initial = computeWidgetPosition(stored, WIDGET_WIDTH, WIDGET_HEIGHT);
  win.setPosition(initial.x, initial.y);

  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  win.on('moved', () => {
    const pos = win.getPosition();
    const x = pos[0];
    const winY = pos[1];
    if (x === undefined || winY === undefined) return;
    // Persist where the bar is, not the grown window's top edge.
    const y =
      barExpand?.direction === 'up' ? winY + WIDGET_EXPANDED_HEIGHT - WIDGET_HEIGHT : winY;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => prefsStore.setWidgetPosition({ x, y }), 300);
  });
  win.on('closed', () => {
    if (moveTimer) clearTimeout(moveTimer);
    floatingWidget = null;
    barExpand = undefined;
    // The bar is the app's main UI (frameless, no taskbar entry): Alt+F4 on it means quit.
    quitIfNoVisibleWindow();
  });

  // Assign before awaiting loadURL so a concurrent call (e.g. double-click on
  // "Concluir setup") sees the in-flight window and short-circuits via the
  // guard above instead of constructing a second BrowserWindow. Mirrors the
  // synchronous-assignment pattern in createSetupView.
  floatingWidget = win;
  await win.loadURL(FLOATING_WIDGET_URL);
  return win;
}

async function createWindows(configStore: ConfigStore, prefsStore: UserPrefsStore): Promise<void> {
  offscreenWindow = new BrowserWindow({
    width: 1, height: 1, show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/offscreenPreload.cjs'),
      contextIsolation: true, nodeIntegration: false,
      // The window is never shown, so Chromium would throttle its timers (1 s, later up to
      // 1 min alignment). Diagnostics measurements, the AudioContext resume watcher and the
      // devicechange debounce all rely on setTimeout firing on time.
      backgroundThrottling: false,
    },
  });
  await offscreenWindow.loadURL(OFFSCREEN_URL);

  if (isSetupComplete(configStore, prefsStore)) {
    await createFloatingWidget(prefsStore);
  } else {
    await createSetupView();
  }
}

async function createSetupView(initialHash = ''): Promise<BrowserWindow> {
  if (setupView && !setupView.isDestroyed()) {
    setupView.focus();
    return setupView;
  }
  setupView = new BrowserWindow({
    width: 860,
    height: 680,
    backgroundColor: '#08090a',
    webPreferences: {
      preload: UI_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep timers and IPC on time while another app is in front.
      backgroundThrottling: false,
    },
  });
  setupHash = initialHash;
  setupView.on('closed', () => {
    setupView = null;
    setupHash = '';
    onSetupViewChanged();
    quitIfNoVisibleWindow();
  });
  // Track the route: the troubleshooting screen keeps passthrough + live health running.
  const onNavigated = (_e: unknown, url: string): void => {
    const hash = hashOf(url);
    if (hash === setupHash) return;
    setupHash = hash;
    onSetupViewChanged();
  };
  setupView.webContents.on('did-navigate-in-page', onNavigated);
  setupView.webContents.on('did-navigate', onNavigated);
  onSetupViewChanged();
  attachExternalLinkHandler(setupView);
  attachNavigationGuard(setupView);
  await setupView.loadURL(`${SETUP_VIEW_URL}${initialHash}`);
  return setupView;
}

/** Local time as YYYYMMDD-HHmm, for default export file names. */
function fileStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function hashOf(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? '' : url.slice(i);
}

/**
 * Whether the setup window needs exclusive use of the audio devices: the first-run wizard
 * (loopback checks on CABLE-A, test playback), the Settings "Audio" section (devices are
 * re-applied when you leave it) and "Test translation". Every other Settings section only
 * reads or saves preferences (the troubleshooting check stops passthrough itself), so the
 * live call keeps going while it is open.
 */
function setupNeedsDevices(): boolean {
  if (!setupView || setupView.isDestroyed()) return false;
  if (!setupHash.startsWith('#/settings')) return !setupHash.startsWith('#/troubleshoot');
  return setupHash.startsWith('#/settings/audio') || setupHash.startsWith('#/settings/test');
}

/** Opens (or re-targets) the setup window on the given route, e.g. '#/troubleshoot'. */
async function openSetupAt(hash: string): Promise<void> {
  if (setupView && !setupView.isDestroyed()) {
    await setupView.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
    if (setupView.isMinimized()) setupView.restore();
    setupView.focus();
    return;
  }
  await createSetupView(hash);
}

const openTroubleshooting = (): Promise<void> => openSetupAt('#/settings/troubleshoot');
/** Assistant settings: a screen that keeps call audio (and STT) running. */
const openAssistantSettings = (): Promise<void> => openSetupAt('#/settings/transcription');
const openSettings = (): Promise<void> => openSetupAt('#/settings/general');

// Keep working at full speed while another app is in front. Without these, Chromium
// deprioritises and throttles our renderers (and Windows applies efficiency mode) as soon
// as you click into another window: translation, typed speech and transcription stall.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
);

app.whenReady().then(async () => {
  // Auto-grant `media` permission so the offscreen window can call
  // navigator.mediaDevices.getUserMedia and enumerateDevices without a prompt.
  // BYOK desktop app — the user already trusts this binary to access the mic.
  // Other permissions (camera, notifications, etc.) are denied by default.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  // Stores must be constructed AFTER app is ready (uses app.getPath).
  // Lifted from handlers.ts so createWindows() can use prefsStore for initial
  // position BEFORE the IPC layer is set up.
  const apiKeyPath = join(app.getPath('userData'), 'apikey.bin');
  const configStore = new ConfigStore({
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (s) => safeStorage.encryptString(s),
      decryptString: (b) => safeStorage.decryptString(b),
    },
    fs: {
      readFile: (p) => (existsSync(p) ? readFileSync(p) : undefined),
      writeFile: (p, d) => atomicWriteFileSync(p, d),
      exists: (p) => existsSync(p),
    },
    configPath: apiKeyPath,
    envApiKey: readEnvApiKey(),
  });

  const prefsPath = join(app.getPath('userData'), 'prefs.json');
  const prefsStore = new UserPrefsStore({
    fs: {
      readFile: (p) => (existsSync(p) ? readFileSync(p) : undefined),
      writeFile: (p, d) => atomicWriteFileSync(p, d),
      exists: (p) => existsSync(p),
    },
    prefsPath,
  });

  // Custom LLM endpoint key (M6): same safeStorage encryption as the OpenAI key, own file.
  const llmKeyStore = new ConfigStore({
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (s) => safeStorage.encryptString(s),
      decryptString: (b) => safeStorage.decryptString(b),
    },
    fs: {
      readFile: (p) => (existsSync(p) ? readFileSync(p) : undefined),
      writeFile: (p, d) => atomicWriteFileSync(p, d),
      exists: (p) => existsSync(p),
    },
    configPath: join(app.getPath('userData'), 'llmkey.bin'),
    envApiKey: undefined,
  });

  // Live transcript window (M6). Not counted by quitIfNoVisibleWindow: closes with the app.
  const transcriptWin = createTranscriptWindowController({
    url: TRANSCRIPT_URL,
    preloadPath: UI_PRELOAD_PATH,
    loadPrefs: () => prefsStore.load().transcriptWindow ?? DEFAULT_TRANSCRIPT_WINDOW,
    savePrefs: (p) => prefsStore.setTranscriptWindow(p),
    attachGuards: (w) => {
      attachNavigationGuard(w);
      attachExternalLinkHandler(w);
    },
  });

  await createWindows(configStore, prefsStore);
  if (!offscreenWindow) throw new Error('offscreen window not created');

  const logsDir = join(app.getPath('userData'), 'logs');
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  logSink = new JsonlSink({ logsDir, sessionId });
  const logger = createLogger({ source: 'main', sink: logSink, minLevel: LogLevel.Info });

  // Both the FloatingWidget and SetupView (when open) want session state +
  // latency so their UIs reflect what's happening. The TestRig stub leans on
  // this during first-launch (before the bar exists), and the gear-opened
  // SetupView would otherwise show stale "idle" mid-session. Fan out to all
  // alive UI windows; offscreen never subscribes.
  const broadcast = <T,>(channel: string, payload: T): void => {
    for (const win of [floatingWidget, setupView, transcriptWin.get()]) {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  };
  // Estimated spend of the paid services since launch (or the last reset in the bar).
  const usageMeter = new UsageMeter({ onChange: (u) => broadcast(IPC.UsageChanged, u) });
  const emitDirectionalState = (s: DirectionalState): void => {
    usageMeter.onTranslateState(s.direction, s.state);
    broadcast(IPC.DirectionalStateChanged, s);
  };
  const emitTranscript = (t: {
    direction: 'A' | 'B';
    kind: 'input' | 'output';
    text: string;
  }): void => {
    broadcast(IPC.TranscriptDelta, t);
    assistant.onTranslateDelta(t);
  };
  const emitLatency = (m: { direction: Direction; averageMs: number; sampleCount: number }): void => {
    broadcast(IPC.LatencyMeasured, m);
  };

  // `manager` is reassigned on each Start (after teardown of any prior session).
  // eslint can't see the closure-mutation pattern, so we suppress prefer-const.
  // eslint-disable-next-line prefer-const
  let manager: SessionManager | undefined;
  // Start/Stop are serialized: device init takes a few hundred ms before any WebSocket
  // exists, so a double-click (or Stop) during that window would otherwise stop a manager
  // that has nothing to close yet, and its sessions would open afterwards unreferenced —
  // orphaned, billable, unstoppable.
  let lifecycle: Promise<unknown> = Promise.resolve();
  /**
   * True inside onStart until the new manager is assigned: the assistant must already see
   * "translating" so STT on pass-* stops before translation opens the devices.
   */
  let starting = false;
  /**
   * Args of the latest Start. activeArgs is only set once the manager started; until then
   * the assistant takes languages / TTS devices from here.
   */
  let startingArgs: BidirectionalArgs | undefined;
  const serialized = <T,>(fn: () => Promise<T>): Promise<T> => {
    const p = lifecycle.then(fn, fn);
    lifecycle = p.catch(() => undefined);
    return p;
  };

  /** Devices of the running translation (the IPC args can differ from saved prefs). */
  let activeArgs: BidirectionalArgs | undefined;

  // Device recovery. Runs on devicechange (debounced), on stream failures, and — while a
  // device-missing / device-failed / audio-suspended issue exists and audio is running —
  // on a poll. Restarts after stream failures back off exponentially (1 s .. 30 s); the
  // poll has its own interval that grows 5 s -> 60 s and only resets when the trouble is
  // over or a devicechange arrives, so an unplugged device that stays unplugged costs one
  // cheap inventory a minute. A target that failed to re-open MAX_RECOVERY_FAILURES times
  // in a row is left alone until the next devicechange / Start / Stop.
  const DEVICE_CHANGE_DEBOUNCE_MS = 800;
  const RECOVERY_POLL_MIN_MS = 5000;
  const RECOVERY_POLL_MAX_MS = 60_000;
  const RECOVERY_QUIET_RESET_MS = 60_000;
  const MAX_RECOVERY_FAILURES = 5;
  const recoveryBackoff = new ExponentialBackoff({
    baseMs: 1000,
    maxMs: 30_000,
    maxAttempts: Number.POSITIVE_INFINITY,
  });
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryRunning = false;
  let lastRecoveryActionMs = 0;
  let pollDelayMs = RECOVERY_POLL_MIN_MS;
  /** Consecutive failed re-opens per target ('A' / 'B' / 'pass-A' / 'pass-B'). */
  const recoveryFailures = new Map<string, number>();
  /** Output device ids of the previous inventory (to spot re-enumerated outputs). */
  let lastOutputIds: Set<string> | undefined;
  /**
   * Re-opening because the output list changed is rate-limited: re-opening a direction
   * also re-opens its input, and a Bluetooth headset could answer that with another
   * devicechange — never let that become a restart loop.
   */
  const OUTPUT_CHANGE_RESTART_MIN_GAP_MS = 30_000;
  let lastOutputChangeRestartMs = 0;

  const resetRecoveryLadder = (): void => {
    recoveryBackoff.reset();
    pollDelayMs = RECOVERY_POLL_MIN_MS;
    recoveryFailures.clear();
  };

  // Audio health: offscreen level/stream signals, the device inventory and device start
  // failures become issues the bar chip + troubleshooting screen explain. Only code/role
  // are logged — never audio or transcript content.
  let loggedIssues = new Set<string>();
  const health = new HealthMonitor({
    onChange: (report: HealthReport) => {
      broadcast(IPC.HealthChanged, report);
      const current = new Set(report.issues.map((i) => `${i.code}|${i.role}`));
      for (const k of current) {
        if (loggedIssues.has(k)) continue;
        const [code, role] = k.split('|');
        logger.info('health_issue_raised', { code, role });
      }
      for (const k of loggedIssues) {
        if (current.has(k)) continue;
        const [code, role] = k.split('|');
        logger.info('health_issue_cleared', { code, role });
      }
      loggedIssues = current;
      if (shouldPoll(report) && !recoveryTimer && !recoveryRunning) {
        scheduleRecovery(pollDelayMs, 'issue');
      }
    },
  });

  // Passthrough idle parking: one park/wake at a time through the serialized lifecycle.
  let passthroughActionPending = false;
  const runPassthroughAction = (action: 'park' | 'wake'): void => {
    if (passthroughActionPending) return;
    passthroughActionPending = true;
    serialized(async () => {
      if (manager) return;
      if (action === 'park') passthrough.park();
      else await passthrough.wake();
      await syncAssistant();
    })
      .catch((err: unknown) =>
        logger.warn('passthrough_action_failed', {
          action,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => {
        passthroughActionPending = false;
      });
  };

  const offscreenBridge = new OffscreenBridge(offscreenWindow, {
    onLevel: (r) => {
      health.onLevel(r);
      if (!manager && (r.streamId === PASSTHROUGH_A || r.streamId === PASSTHROUGH_B)) {
        const action = passthrough.onLevel(r);
        if (action) runPassthroughAction(action);
      }
    },
    onStreamEvent: (e) => {
      logger.info('offscreen_stream_event', {
        streamId: e.streamId,
        kind: e.kind,
        side: e.side ?? 'input',
      });
      // Typed-speech streams (tts, tts-mon) are not call audio: no health issue, no
      // recovery restart; the assistant drops them and re-opens on the next speak.
      if (e.streamId.startsWith('tts')) {
        assistant.onTtsStreamEvent();
        return;
      }
      health.onStreamEvent(e);
      if (e.kind !== 'context-resumed') scheduleRecovery(nextRecoveryDelay(), `stream-${e.kind}`);
    },
    onDeviceChange: () => {
      // Windows fires a burst of devicechange events while a driver (re)loads: debounce,
      // and start the retry ladder over — the user just plugged/unplugged something.
      resetRecoveryLadder();
      scheduleRecovery(DEVICE_CHANGE_DEBOUNCE_MS, 'device-change');
      assistant.onDeviceChange();
    },
  });

  // Untranslated audio while idle, so the call works before Start. Off while the setup
  // window shows a screen that uses the devices (wizard/review): its loopback check
  // listens on CABLE-A and would hear the mic, and test playback would mix with the live
  // call. While translating, a direction whose session died runs as passthrough instead
  // (see failedDirections) so the call doesn't go silent.
  const passthrough = new Passthrough(offscreenBridge, logger, {
    onFailure: (role, detail) => health.reportFailure(role, detail),
    onStarted: (role) => health.clearFailure(role),
  });
  /** Translation directions whose session ended in a terminal error. */
  const failedDirections = new Set<Direction>();
  const DIRECTION_PASSTHROUGH: Record<Direction, string> = { A: PASSTHROUGH_A, B: PASSTHROUGH_B };
  const PASSTHROUGH_DIRECTION: Record<string, Direction> = {
    [PASSTHROUGH_A]: 'A',
    [PASSTHROUGH_B]: 'B',
  };

  /** What the call assistant may use right now (spec §9). */
  /**
   * True while runDiagnostics plays tones / measures on the call devices: typed speech is
   * refused (tts-busy-setup) and STT stays off, exactly as while setup owns the devices.
   */
  let diagnosing = false;
  const audioState = (): AssistantAudioState => {
    const translating = !!manager || starting;
    const args = translating ? (activeArgs ?? startingArgs) : undefined;
    let langs: AssistantAudioState['langs'];
    let toMeet: string | undefined;
    let headset: string | undefined;
    if (args) {
      langs = { user: args.sourceLang, them: args.targetLang };
      toMeet = args.toMeetDeviceId;
      headset = args.headsetDeviceId;
    } else {
      const prefs = prefsStore.load();
      langs = { user: prefs.languages?.source ?? 'pt', them: prefs.languages?.target ?? 'en' };
      toMeet = prefs.devices?.toMeet;
      headset = prefs.devices?.headset;
    }
    const sttStreams: AssistantAudioState['sttStreams'] = [];
    if (translating) {
      // Only directions running as fallback passthrough (their session failed).
      for (const direction of failedDirections) {
        sttStreams.push({ direction, streamId: DIRECTION_PASSTHROUGH[direction] });
      }
    } else if (passthrough.isRunning) {
      for (const streamId of passthrough.streams) {
        const direction = PASSTHROUGH_DIRECTION[streamId];
        if (!direction) continue;
        if (streamId === PASSTHROUGH_A && passthrough.isMicParked) continue;
        sttStreams.push({ direction, streamId });
      }
    }
    return {
      translating,
      langs,
      ttsDevices: { ...(toMeet ? { toMeet } : {}), ...(headset ? { headset } : {}) },
      sttStreams,
      setupBusy: setupNeedsDevices() || diagnosing,
    };
  };

  const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  // Call assistant (M6): transcript, STT, typed speech, suggestions. Device-touching work
  // (syncAudio) always runs inside serialized(); typed speech does not (memoised sink).
  /** Last STT status pushed by the assistant: transcribing in passthrough counts as busy. */
  let sttListening = false;
  /** powerSaveBlocker id while busy (see syncPowerBlock). */
  let powerBlockId: number | undefined;
  const assistant = new AssistantRuntime({
    fetch: nodeFetch,
    wsFactory,
    offscreen: offscreenBridge,
    loadStoredPrefs: () => prefsStore.load().assistant,
    saveAssistantPrefs: (patch) => prefsStore.setAssistant(patch),
    openAiKey: () => configStore.getApiKey(),
    llmKeyStore,
    audioState,
    serialized,
    broadcast: (channel, payload) => {
      broadcast(channel, payload);
      if (channel === IPC.SttStatusChanged) {
        sttListening = (payload as SttStatus).state === 'listening';
        syncPowerBlock();
      }
    },
    // Resolved per call so the export follows the current UI language.
    t: (key, vars) => createT(getDictionary(resolveLocale(prefsStore)))(key, vars),
    logger,
    usage: usageMeter,
  });

  /**
   * Saves what reconcileDevices found for the current inventory. Returns true when a saved
   * device was re-found under a new id.
   */
  const applyDeviceReconcile = (inventory: DeviceInventory): boolean => {
    const prefs = prefsStore.load();
    if (!prefs.devices) return false;
    const r = reconcileDevices(prefs.devices, prefs.deviceLabels, inventory);
    if (!r.changed) return false;
    prefsStore.setDevicesAndLabels(r.devices, r.labels);
    if (r.remapped.length > 0) logger.info('devices_refound_by_label', { roles: r.remapped });
    return r.remapped.length > 0;
  };
  const reconcileSavedDevices = async (): Promise<boolean> => {
    if (!offscreenWindow || offscreenWindow.isDestroyed()) return false;
    try {
      return applyDeviceReconcile(await buildDeviceInventory(offscreenWindow));
    } catch (err) {
      logger.warn('device_reconcile_failed', { message: errMessage(err) });
      return false;
    }
  };

  /** Converges STT; never fails the audio operation it follows (must run in serialized()). */
  const syncAssistant = async (): Promise<void> => {
    try {
      await assistant.syncAudio();
    } catch (err) {
      logger.warn('assistant_sync_failed', { message: errMessage(err) });
    }
  };

  const syncPassthrough = async (): Promise<void> => {
    if (manager) {
      // Fallback only: untranslated audio for the directions whose session failed.
      const d = activeArgs
        ? {
            mic: activeArgs.micDeviceId,
            toMeet: activeArgs.toMeetDeviceId,
            fromMeet: activeArgs.fromMeetDeviceId,
            headset: activeArgs.headsetDeviceId,
          }
        : undefined;
      const streams = [...failedDirections].map((dir) => DIRECTION_PASSTHROUGH[dir]);
      await passthrough.sync(d, streams.length > 0, streams);
    } else {
      await passthrough.sync(prefsStore.load().devices, !setupNeedsDevices());
    }
    syncHealthMode();
    await syncAssistant();
  };

  /** Keeps the monitor's mode + watched streams in step with what audio is running. */
  /**
   * While translating or transcribing, ask Windows not to suspend or throttle the app (also
   * keeps the PC from sleeping mid-call; the screen may still turn off). Released when idle.
   */
  function syncPowerBlock(): void {
    const busy = manager !== undefined || sttListening;
    if (busy && powerBlockId === undefined) {
      powerBlockId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!busy && powerBlockId !== undefined) {
      powerSaveBlocker.stop(powerBlockId);
      powerBlockId = undefined;
    }
  }

  function syncHealthMode(): void {
    const roles = (ids: Record<Direction, string>): Record<string, DeviceRole> => ({
      [ids.A]: 'mic',
      [outputStreamKey(ids.A)]: 'toCall',
      [ids.B]: 'fromCall',
      [outputStreamKey(ids.B)]: 'headset',
    });
    syncPowerBlock();
    if (manager) {
      health.setMode('translating', roles({ A: 'A', B: 'B' }));
    } else if (passthrough.isRunning) {
      health.setMode('passthrough', roles(DIRECTION_PASSTHROUGH));
    } else {
      health.setMode('off', {});
    }
    // Re-check presence against the device set that is now active.
    if (!recoveryRunning) scheduleRecovery(DEVICE_CHANGE_DEBOUNCE_MS, 'mode-change');
  }

  function needsRecovery(report: HealthReport): boolean {
    return report.issues.some(
      (i) => i.code === 'device-missing' || i.code === 'device-failed' || i.code === 'audio-suspended',
    );
  }

  /** Polling only helps while audio is running: in 'off' nothing would be re-opened. */
  function shouldPoll(report: HealthReport): boolean {
    return report.mode !== 'off' && needsRecovery(report);
  }

  function nextRecoveryDelay(): number {
    // No restart for a while: the previous trouble is over, start again from a short delay.
    if (Date.now() - lastRecoveryActionMs > RECOVERY_QUIET_RESET_MS) recoveryBackoff.reset();
    return recoveryBackoff.next();
  }

  function scheduleRecovery(delayMs: number, reason: string): void {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      recoveryRunning = true;
      serialized(() => recoverAudio(reason))
        .catch((err: unknown) =>
          logger.warn('audio_recovery_failed', {
            reason,
            message: err instanceof Error ? err.message : String(err),
          }),
        )
        .finally(() => {
          recoveryRunning = false;
          if (recoveryTimer) return;
          if (!shouldPoll(health.getReport())) {
            pollDelayMs = RECOVERY_POLL_MIN_MS;
            return;
          }
          const delay = pollDelayMs;
          pollDelayMs = Math.min(pollDelayMs * 2, RECOVERY_POLL_MAX_MS);
          scheduleRecovery(delay, 'poll');
        });
    }, delayMs);
  }

  const ROLE_DIRECTION: Record<DeviceRole, Direction> = {
    mic: 'A',
    toCall: 'A',
    fromCall: 'B',
    headset: 'B',
  };
  const DIRECTION_ROLES: Record<Direction, DeviceRole[]> = {
    A: ['mic', 'toCall'],
    B: ['fromCall', 'headset'],
  };
  const OUTPUT_ROLES: DeviceRole[] = ['toCall', 'headset'];

  function activeDeviceIds(): Record<DeviceRole, string | undefined> {
    if (manager && activeArgs) {
      return {
        mic: activeArgs.micDeviceId,
        toCall: activeArgs.toMeetDeviceId,
        fromCall: activeArgs.fromMeetDeviceId,
        headset: activeArgs.headsetDeviceId,
      };
    }
    const d = prefsStore.load().devices;
    return { mic: d?.mic, toCall: d?.toMeet, fromCall: d?.fromMeet, headset: d?.headset };
  }

  /** Re-opens one target; tracks consecutive failures. Returns false when skipped/failed. */
  async function reopen(target: string, open: () => Promise<boolean>): Promise<boolean> {
    const failures = recoveryFailures.get(target) ?? 0;
    if (failures >= MAX_RECOVERY_FAILURES) return false;
    const ok = await open();
    if (ok) {
      recoveryFailures.delete(target);
      health.resetStream(target);
    } else {
      recoveryFailures.set(target, failures + 1);
      if (failures + 1 === MAX_RECOVERY_FAILURES) {
        logger.warn('audio_recovery_gave_up', { target, attempts: failures + 1 });
      }
    }
    logger.info(ok ? 'audio_recovery_restarted' : 'audio_recovery_restart_failed', { target });
    return ok;
  }

  /**
   * Must run inside serialized(). Refreshes 'device-missing' for the active device set and
   * re-opens audio — only the directions involved — for every role that was broken
   * (missing / failed / suspended) and whose device is present now. After a devicechange
   * that altered the output list, running outputs are re-opened too: a sink that vanished
   * and came back (VB-Cable driver restart, quick replug) leaves its AudioContext writing
   * into a dead endpoint without any error. Translation keeps its WebSockets.
   */
  async function recoverAudio(reason: string): Promise<void> {
    if (!offscreenWindow || offscreenWindow.isDestroyed()) return;
    // A device whose id changed (driver reinstall, Windows update) is re-found by its name;
    // the idle passthrough then reopens on the new ids. While translating the running
    // session keeps its ids until the next Start.
    if (await reconcileSavedDevices()) {
      if (!manager) await syncPassthrough();
    }
    const before = health.getReport();
    const inventory = await buildDeviceInventory(offscreenWindow);
    const ids = activeDeviceIds();
    const missing = findMissingRoles(ids, inventory);
    health.setMissing(missing);

    const outputs = presentDeviceIds(inventory).outputs;
    const outputsChanged =
      lastOutputIds !== undefined &&
      (outputs.size !== lastOutputIds.size || [...outputs].some((id) => !lastOutputIds!.has(id)));
    lastOutputIds = outputs;

    const broken = new Set(
      before.issues
        .filter((i) => i.code === 'device-missing' || i.code === 'device-failed' || i.code === 'audio-suspended')
        .map((i) => i.role),
    );
    if (outputsChanged && Date.now() - lastOutputChangeRestartMs >= OUTPUT_CHANGE_RESTART_MIN_GAP_MS) {
      const sizeBefore = broken.size;
      for (const r of OUTPUT_ROLES) {
        const id = ids[r];
        if (id && outputs.has(id)) broken.add(r);
      }
      if (broken.size > sizeBefore) lastOutputChangeRestartMs = Date.now();
    }
    const recovered = [...broken].filter((r) => !missing.includes(r));
    if (recovered.length === 0 || (!manager && !passthrough.isRunning)) return;

    lastRecoveryActionMs = Date.now();
    logger.info('audio_recovery_attempt', { reason, roles: recovered, mode: before.mode });
    const directions = [...new Set(recovered.map((r) => ROLE_DIRECTION[r]))];
    for (const direction of directions) {
      const m = manager;
      if (m && !failedDirections.has(direction)) {
        await reopen(direction, async () => {
          try {
            await m.restartAudio(direction);
          } catch (err) {
            // Device failures were already reported to `health` via onDeviceFailure.
            logger.warn('audio_recovery_restart_error', {
              target: direction,
              message: err instanceof Error ? err.message : String(err),
            });
            return false;
          }
          for (const r of DIRECTION_ROLES[direction]) health.clearFailure(r);
          return true;
        });
      } else {
        // Passthrough's onStarted/onFailure callbacks update `health`.
        const stream = DIRECTION_PASSTHROUGH[direction];
        if (passthrough.streams.includes(stream)) {
          await reopen(stream, () => passthrough.restartStream(stream));
        }
      }
    }
  }

  /**
   * A direction whose session ended in a terminal error (reconnects exhausted, quota,
   * invalid key) would leave that side of the call silent until Stop. Route it untranslated
   * instead; the bar still shows the direction's error.
   */
  function onTranslationState(m: SessionManager, s: DirectionalState): void {
    if (m !== manager || !activeArgs) return; // stale manager, or still starting
    const failed = s.state.kind === 'error';
    if (failed === failedDirections.has(s.direction)) return;
    if (failed) failedDirections.add(s.direction);
    else failedDirections.delete(s.direction);
    logger.info(failed ? 'translation_fallback_passthrough_on' : 'translation_fallback_passthrough_off', {
      direction: s.direction,
    });
    serialized(async () => {
      if (m === manager) await syncPassthrough();
    }).catch((err: unknown) =>
      logger.warn('passthrough_sync_failed', {
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // Explicit teardown on quit: stop billing sessions and release every device before the
  // windows go away (stop() calls are synchronous at their core — no await needed).
  app.on('before-quit', () => {
    void assistant.dispose().catch(() => undefined);
    usageMeter.dispose();
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    const m = manager;
    manager = undefined;
    activeArgs = undefined;
    m?.stop().catch(() => undefined);
    passthrough.stop();
    offscreenBridge.stopAll();
    offscreenBridge.dispose();
  });

  onSetupViewChanged = () => {
    assistant.onSetupViewChanged();
    serialized(syncPassthrough).catch((err: unknown) =>
      logger.warn('passthrough_sync_failed', {
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  };
  // Before the first passthrough: re-find saved devices whose id changed since last run.
  serialized(() => reconcileSavedDevices())
    .catch(() => false)
    .finally(() => onSetupViewChanged());

  // Test Translation (M4 Phase E). Each direction is an independent OpenAISession
  // started with its own source/target language pair; translated audio is forwarded
  // to setupView (via dynamic `test:audio:${direction}` channel) so the renderer can
  // route it to the desired playback device. Playback streams are reused across
  // chunks of a single test run and torn down on stop.
  const testSessions = new TestSessionRegistry();
  // Promise (not boolean) so concurrent chunks all await the SAME startPlayback
  // call — otherwise the first chunk awaits, the second/third see flag=false
  // and fire duplicate startPlayback calls; the offscreen registry tears down
  // the first handle when the second arrives, so chunks pushed in between get
  // dropped → choppy audio. With the Promise, every chunk waits for the same
  // resolution before pushing.
  const testPlaybacks = new Map<string, Promise<void>>();

  const runTestPlayback = async (
    direction: Direction,
    deviceId: string,
    base64: string,
  ): Promise<void> => {
    const streamId = `test-${direction}`;
    let p = testPlaybacks.get(streamId);
    if (!p) {
      p = offscreenBridge.startPlayback(streamId, deviceId);
      testPlaybacks.set(streamId, p);
    }
    await p;
    offscreenBridge.pushPlayback(streamId, base64);
  };

  // Auto-update wiring. Skipped in dev (app.isPackaged false), in the portable exe, and
  // unless REALTIME_TRANSLATE_AUTO_UPDATE=1 (see updater.ts). When opted in,
  // setupAutoUpdate registers listeners on autoUpdater that broadcast version
  // info to the FloatingWidget + SetupView so they can show "update available"
  // / "update ready to install" badges. The user can click the badge (Task 7
  // wires the UI) to invoke ApplyUpdate, which calls quitAndInstall(). Or
  // they can just close the app naturally — autoInstallOnAppQuit=true applies
  // the update on next quit.
  const updater = setupAutoUpdate({
    onAvailable: (version) => broadcast(IPC.UpdateAvailable, { version }),
    onDownloaded: (version) => broadcast(IPC.UpdateDownloaded, { version }),
  });

  // Only our own pages in the bar / setup / transcript windows may drive the app (open
  // devices, play tones or typed speech into the call, start paid sessions).
  const isTrustedSender = (e: Electron.IpcMainInvokeEvent): boolean => {
    const trusted = [floatingWidget, setupView, transcriptWin.get()].some(
      (w) => w && !w.isDestroyed() && w.webContents === e.sender,
    );
    const frameUrl = e.senderFrame?.url;
    return trusted && frameUrl !== undefined && isAppUrl(frameUrl);
  };

  /** Transcript export: the only disk write of transcript content (user-chosen path). */
  const saveExport = async (
    format: 'txt' | 'md',
    text: string,
    sender: unknown,
  ): Promise<{ saved: boolean }> => {
    const opts = {
      defaultPath: `transcript-${fileStamp(new Date())}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    };
    const w = BrowserWindow.fromWebContents(sender as WebContents);
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return { saved: false };
    writeFileSync(r.filePath, text, 'utf8');
    return { saved: true };
  };

  registerIpcHandlers({
    configStore,
    prefsStore,
    isTrustedSender,
    onStart: (args) => serialized(async () => {
      // If a previous session is still running (e.g., user clicked Start twice), tear it
      // down first so we don't leak resources or double-bind IPC channels.
      if (manager) {
        await manager.stop();
        manager = undefined;
        activeArgs = undefined;
        assistant.onTranslateStop();
      }
      failedDirections.clear();
      resetRecoveryLadder();
      // Until the manager is assigned the assistant sees "translating" with no failed
      // direction, so STT on pass-* stops before translation opens the devices.
      starting = true;
      startingArgs = args;
      let m: SessionManager;
      try {
        await syncAssistant();
        passthrough.stop();
        const apiKey = configStore.getApiKey();
        if (!apiKey) {
          const message = 'No API key configured';
          emitDirectionalState({ direction: 'A', state: { kind: 'error', message } });
          emitDirectionalState({ direction: 'B', state: { kind: 'error', message } });
          starting = false;
          startingArgs = undefined;
          await syncPassthrough();
          throw new Error(message);
        }
        const inputTranscriptionModel = assistant.inputTranscriptionModel();
        const created: SessionManager = new SessionManager({
          apiKey,
          sourceLang: args.sourceLang,
          targetLang: args.targetLang,
          micDeviceId: args.micDeviceId,
          toMeetDeviceId: args.toMeetDeviceId,
          fromMeetDeviceId: args.fromMeetDeviceId,
          headsetDeviceId: args.headsetDeviceId,
          offscreen: offscreenBridge,
          wsFactory,
          onDirectionalState: (s) => {
            emitDirectionalState(s);
            onTranslationState(created, s);
          },
          onTranscript: emitTranscript,
          onLatencyMeasured: emitLatency,
          onDeviceFailure: ({ direction, side, message }) => {
            health.reportFailure(DIRECTION_ROLES[direction][side === 'input' ? 0 : 1]!, message);
          },
          ...(inputTranscriptionModel ? { inputTranscriptionModel } : {}),
          voice: assistant.prefs().translateVoice,
          onInputTranscriptionRejected: (d) => assistant.onInputTranscriptionRejected(d),
          logger,
        });
        m = created;
        manager = m;
      } finally {
        starting = false;
      }
      try {
        await m.start();
        activeArgs = args;
        // Every device just opened fine: failures left over from passthrough (or an
        // earlier run) are stale, and would otherwise make recovery restart a healthy
        // direction.
        for (const r of ['mic', 'toCall', 'fromCall', 'headset'] as const) health.clearFailure(r);
        syncHealthMode();
        assistant.onTranslateStart();
      } catch (err) {
        // SessionManager already tore both directions down on rejection; stop() here is a
        // defensive no-op. Wrap it so a secondary failure during cleanup doesn't mask the
        // original start error.
        try {
          await m.stop();
        } catch (stopErr) {
          logger.error('session_manager_stop_failed', {
            message: stopErr instanceof Error ? stopErr.message : String(stopErr),
          });
        }
        manager = undefined;
        assistant.onTranslateStop();
        await syncPassthrough();
        throw err;
      }
    }),
    onStop: () => serialized(async () => {
      if (manager) {
        await manager.stop();
        manager = undefined;
        activeArgs = undefined;
      }
      failedDirections.clear();
      resetRecoveryLadder();
      // Finalizes open transcript entries; syncPassthrough() then re-syncs STT.
      assistant.onTranslateStop();
      await syncPassthrough();
    }),
    listDevices: async () => {
      const inventory = await buildDeviceInventory(offscreenWindow!);
      applyDeviceReconcile(inventory);
      return inventory;
    },
    openSetupView: async () => {
      // Post-setup gear opens Settings; pre-setup callers don't reach this IPC (the
      // wizard auto-opens at startup via createWindows).
      await openSettings();
    },
    onSetupComplete: async () => {
      await createFloatingWidget(prefsStore);
      if (setupView && !setupView.isDestroyed()) setupView.close();
    },
    showBarMenu: (sender) => {
      const win = BrowserWindow.fromWebContents(sender);
      if (!win) return;
      const locale = resolveLocale(prefsStore);
      const t = createT(getDictionary(locale));
      const menu = Menu.buildFromTemplate([
        { label: t('menu.transcript'), click: () => { void transcriptWin.open(); } },
        { type: 'separator' },
        { label: t('menu.settings'), click: () => { void openSettings(); } },
        { label: t('menu.troubleshoot'), click: () => { void openTroubleshooting(); } },
        { type: 'separator' },
        { label: t('menu.quit'), accelerator: 'Alt+F4', click: () => app.quit() },
      ]);
      menu.popup({ window: win });
    },
    setBarExpanded: ({ expanded }) => setBarExpanded(expanded),
    setBarMouseEvents: ({ ignore }) => {
      if (floatingWidget && !floatingWidget.isDestroyed()) {
        floatingWidget.setIgnoreMouseEvents(ignore, { forward: true });
      }
    },
    quitApp: () => app.quit(),
    openExternalUrl: async (url) => {
      const parsed = validateExternalUrl(url);
      await shell.openExternal(parsed.toString());
    },
    resolveLocale: () => resolveLocale(prefsStore),
    testSessionStart: ({ direction, sourceLang, targetLang }) => {
      const apiKey = configStore.getApiKey();
      if (!apiKey) throw new Error('No API key');
      testSessions.start(direction, sourceLang, targetLang, {
        apiKey,
        wsFactory,
        onAudio: (b64) => {
          if (setupView && !setupView.isDestroyed()) {
            setupView.webContents.send(`test:audio:${direction}`, b64);
          }
        },
      });
    },
    testSessionInject: ({ direction, base64 }) => testSessions.inject(direction, base64),
    testSessionInputDone: ({ direction }) => testSessions.inputDone(direction),
    testSessionStop: ({ direction }) => {
      testSessions.stop(direction);
      const streamId = `test-${direction}`;
      offscreenBridge.stopStream(streamId);
      testPlaybacks.delete(streamId);
    },
    runLoopback: (deviceId, thresholdRms, timeoutMs) =>
      runLoopback(offscreenWindow!, deviceId, thresholdRms, timeoutMs),
    runTestPlayback: (direction, deviceId, base64) =>
      runTestPlayback(direction, deviceId, base64),
    applyUpdate: async () => {
      updater.quitAndInstall();
    },
    getHealth: () => health.getReport(),
    runDiagnostics: () => serialized(async () => {
      // Diagnostics open the same devices as translation and play test tones into the call.
      if (manager) throw new Error('busy-translating');
      const win = offscreenWindow;
      if (!win || win.isDestroyed()) throw new Error('offscreen window unavailable');
      // STT taps and typed speech use the same devices; the finally below re-syncs STT.
      diagnosing = true;
      try {
        await assistant.stopForDiagnostics();
        passthrough.stop();
        syncHealthMode();
        logger.info('diagnostics_started');
        const result = await runDiagnostics({
          hasApiKey: configStore.getApiKey() !== undefined,
          // Always the SAVED devices: the renderer never chooses what we open.
          devices: prefsStore.load().devices,
          inventory: await buildDeviceInventory(win),
          measureInput: (id, ms) => offscreenBridge.measureInput(id, ms),
          playTone: (id, ms, hz, gainDb) => offscreenBridge.playTone(id, ms, hz, gainDb),
          logger,
        });
        logger.info('diagnostics_finished', {
          failed: result.checks.filter((c) => c.status === 'fail').map((c) => c.id),
          warned: result.checks.filter((c) => c.status === 'warn').map((c) => c.id),
        });
        return result;
      } finally {
        diagnosing = false;
        await syncPassthrough();
      }
    }),
    openTroubleshooting: () => openTroubleshooting(),
    onPrefsChanged: (what) => {
      // New device choices: remember their labels right away.
      if (what === 'devices') {
        void serialized(() => reconcileSavedDevices()).catch(() => undefined);
      }
      void assistant.onPrefsChanged(what).catch((err: unknown) =>
        logger.warn('assistant_prefs_sync_failed', { what, message: errMessage(err) }),
      );
    },
  });

  registerAssistantIpcHandlers(ipcMain, {
    isTrustedSender,
    ...assistant.handlerDeps({
      openTranscriptView: () => transcriptWin.open(),
      openAssistantSettings,
      setTranscriptAlwaysOnTop: (v) => transcriptWin.setAlwaysOnTop(v),
      saveExport,
    }),
    getUsage: () => usageMeter.snapshot(),
    resetUsage: () => {
      usageMeter.reset();
      return usageMeter.snapshot();
    },
  });

  if (assistant.prefs().transcriptOpenOnLaunch && isSetupComplete(configStore, prefsStore)) {
    transcriptWin.open().catch((err: unknown) =>
      logger.warn('transcript_window_open_failed', { message: errMessage(err) }),
    );
  }

  // 5-second delay so the auto-update check doesn't compete with first-launch
  // wizard mounting. setTimeout is fire-and-forget — checkNow swallows its own
  // errors so a network blip can't take down the main process.
  setTimeout(() => {
    void updater.checkNow();
  }, 5000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await logSink?.close();
});
