/**
 * In-memory transcript ring buffer (spec §6.1). Replaces entries by id, fires `onFinal` exactly
 * once per id when `final` first becomes true, and never persists anything (export is the only
 * path to disk). Pure: no Electron.
 */
import type { TranscriptEntry } from '@shared/assistant';

export const DEFAULT_MAX_ENTRIES = 500;

export interface TranscriptStoreDeps {
  now: () => number;
  onUpsert: (e: TranscriptEntry) => void;
  onCleared: () => void;
  onFinal?: (e: TranscriptEntry) => void;
  maxEntries?: number; // 500
}

function copy(e: TranscriptEntry): TranscriptEntry {
  return { ...e };
}

function hasText(e: TranscriptEntry): boolean {
  return e.original.trim() !== '' || e.translated.trim() !== '';
}

export class TranscriptStore {
  private readonly deps: TranscriptStoreDeps;
  private readonly maxEntries: number;
  private entries: TranscriptEntry[] = [];
  /** Ids whose `onFinal` already fired. Pruned on eviction, cleared on `clear()`. */
  private readonly finalFired = new Set<string>();

  constructor(deps: TranscriptStoreDeps) {
    this.deps = deps;
    this.maxEntries = Math.max(1, Math.floor(deps.maxEntries ?? DEFAULT_MAX_ENTRIES));
  }

  /** Replace by id or append; fires onFinal once when final first becomes true. */
  upsert(e: TranscriptEntry): void {
    this.put(copy(e));
  }

  /** Sets updatedAt; calls onUpsert; may fire onFinal. */
  patch(id: string, p: Partial<Omit<TranscriptEntry, 'id'>>): TranscriptEntry | undefined {
    const existing = this.entries.find((x) => x.id === id);
    if (!existing) return undefined;
    const next: TranscriptEntry = { ...existing, ...p, id, updatedAt: this.deps.now() };
    this.put(next);
    return copy(next);
  }

  get(id: string): TranscriptEntry | undefined {
    const e = this.entries.find((x) => x.id === id);
    return e ? copy(e) : undefined;
  }

  /** Oldest → newest, copies. */
  snapshot(): TranscriptEntry[] {
    return this.entries.map(copy);
  }

  /**
   * The newest entries with text, oldest → newest, at most `maxEntries` and `maxChars`
   * (`original.length + translated.length`). Stops at the first entry that would exceed the
   * character budget, except that the newest eligible entry is always included.
   */
  recent(opts: { maxEntries: number; maxChars: number; finalOnly?: boolean }): TranscriptEntry[] {
    const out: TranscriptEntry[] = [];
    let chars = 0;
    for (let i = this.entries.length - 1; i >= 0 && out.length < opts.maxEntries; i--) {
      const e = this.entries[i];
      if (!e || !hasText(e)) continue;
      if (opts.finalOnly && !e.final) continue;
      const len = e.original.length + e.translated.length;
      if (out.length > 0 && chars + len > opts.maxChars) break;
      chars += len;
      out.push(copy(e));
    }
    return out.reverse();
  }

  clear(): void {
    this.entries = [];
    this.finalFired.clear();
    this.deps.onCleared();
  }

  private put(e: TranscriptEntry): void {
    const idx = this.entries.findIndex((x) => x.id === e.id);
    if (idx >= 0) {
      this.entries[idx] = e;
    } else {
      this.entries.push(e);
      while (this.entries.length > this.maxEntries) {
        const dropped = this.entries.shift();
        if (dropped) this.finalFired.delete(dropped.id);
      }
    }
    this.deps.onUpsert(copy(e));
    if (e.final && !this.finalFired.has(e.id)) {
      this.finalFired.add(e.id);
      this.deps.onFinal?.(copy(e));
    }
  }
}
