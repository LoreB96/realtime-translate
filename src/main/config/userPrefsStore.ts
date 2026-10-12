import type { LanguageCode } from '../../shared/languages';
import type { Locale } from '../../shared/i18n';
import {
  DEFAULT_TRANSCRIPT_WINDOW,
  mergeAssistantPrefs,
  resolveAssistantPrefs,
  type AssistantPrefs,
  type AssistantPrefsPatch,
  type StoredAssistantPrefs,
  type TranscriptWindowPrefs,
} from '../../shared/assistant';

export interface FileSystem {
  readFile(path: string): Buffer | undefined;
  writeFile(path: string, data: Buffer): void;
  exists(path: string): boolean;
}

export interface WidgetPosition {
  x: number;
  y: number;
}

export interface DevicePrefs {
  mic?: string;
  toMeet?: string;
  fromMeet?: string;
  headset?: string;
}

export interface Languages {
  source: LanguageCode;
  target: LanguageCode;
}

export interface UserPrefs {
  widgetPosition?: WidgetPosition;
  languages?: Languages;
  devices?: DevicePrefs;
  /** Device id → label of the saved devices, to re-find them if Windows changes the ids. */
  deviceLabels?: Record<string, string>;
  uiLanguage?: Locale;
  meetConfirmed?: boolean;
  /** Call assistant (M6). Partial on disk; read through resolveAssistantPrefs. */
  assistant?: StoredAssistantPrefs;
  transcriptWindow?: TranscriptWindowPrefs;
}

export interface UserPrefsStoreDeps {
  fs: FileSystem;
  prefsPath: string;
}

export class UserPrefsStore {
  constructor(private readonly deps: UserPrefsStoreDeps) {}

  /** Second copy of every save: settings survive a damaged or missing prefs.json. */
  get backupPath(): string {
    return `${this.deps.prefsPath}.bak`;
  }

  load(): UserPrefs {
    return this.read(this.deps.prefsPath) ?? this.read(this.backupPath) ?? {};
  }

  save(prefs: UserPrefs): void {
    const buf = Buffer.from(JSON.stringify(prefs, null, 2), 'utf8');
    this.deps.fs.writeFile(this.deps.prefsPath, buf);
    this.deps.fs.writeFile(this.backupPath, buf);
  }

  /** Parsed prefs object, or undefined when the file is missing, empty or corrupt. */
  private read(path: string): UserPrefs | undefined {
    if (!this.deps.fs.exists(path)) return undefined;
    const raw = this.deps.fs.readFile(path);
    if (!raw || raw.length === 0) return undefined;
    try {
      const v: unknown = JSON.parse(raw.toString('utf8'));
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as UserPrefs) : undefined;
    } catch {
      return undefined;
    }
  }

  setWidgetPosition(pos: WidgetPosition): void {
    const prefs = this.load();
    prefs.widgetPosition = pos;
    this.save(prefs);
  }

  setLanguages(langs: Languages): void {
    const prefs = this.load();
    prefs.languages = langs;
    this.save(prefs);
  }

  setDevices(devices: DevicePrefs): void {
    const prefs = this.load();
    prefs.devices = devices;
    this.save(prefs);
  }

  /** Saves devices re-found by label (see reconcileDevices) together with their labels. */
  setDevicesAndLabels(devices: DevicePrefs, labels: Record<string, string>): void {
    const prefs = this.load();
    prefs.devices = devices;
    prefs.deviceLabels = labels;
    this.save(prefs);
  }

  setUiLanguage(locale: Locale): void {
    const prefs = this.load();
    prefs.uiLanguage = locale;
    this.save(prefs);
  }

  setMeetConfirmed(value: boolean): void {
    const prefs = this.load();
    prefs.meetConfirmed = value;
    this.save(prefs);
  }

  /** Deep-merges `llm`; returns the resolved (defaults-filled, validated) prefs. */
  setAssistant(patch: AssistantPrefsPatch): AssistantPrefs {
    const prefs = this.load();
    const merged = mergeAssistantPrefs(prefs.assistant, patch);
    prefs.assistant = merged;
    this.save(prefs);
    return resolveAssistantPrefs(merged);
  }

  /** Shallow-merges over the stored value (or the defaults). */
  setTranscriptWindow(p: Partial<TranscriptWindowPrefs>): void {
    const prefs = this.load();
    prefs.transcriptWindow = { ...(prefs.transcriptWindow ?? DEFAULT_TRANSCRIPT_WINDOW), ...p };
    this.save(prefs);
  }
}
