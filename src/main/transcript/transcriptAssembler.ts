/**
 * Turns translate-session transcript deltas into utterance-sized TranscriptEntry objects
 * (spec §6.1). Translate deltas carry no utterance boundary, so the assembler decides where an
 * entry ends from timing alone. Pure: no Electron, no timers (the caller runs `tick()`).
 */
import { joinDelta, speakerOf, type TranscriptEntry } from '@shared/assistant';
import type { LanguageCode } from '@shared/languages';
import type { Direction } from '@shared/types';

export const FINALIZE_IDLE_MS = 1800;
export const OUTPUT_LAG_MS = 4000;
export const LONG_ENTRY_MS = 30000;
export const LATE_OUTPUT_MS = 3000;

/** `translated` ends a sentence (trailing whitespace ignored). */
const SENTENCE_END_RE = /[.?!…。？！]\s*$/u;

export interface AssemblerDeps {
  now: () => number;
  langs: () => { user: LanguageCode; them: LanguageCode };
}

interface OpenState {
  entry: TranscriptEntry;
  lastInputAt?: number;
  lastOutputAt?: number;
}

interface FinalState {
  entry: TranscriptEntry;
  finalizedAt: number;
  /** Time of the last late output attached to this entry (continues a multi-delta late translation). */
  lateAt?: number;
}

interface DirectionState {
  open?: OpenState;
  lastFinal?: FinalState;
}

const DIRECTIONS: readonly Direction[] = ['A', 'B'];

function copy(e: TranscriptEntry): TranscriptEntry {
  return { ...e };
}

export class TranscriptAssembler {
  private readonly deps: AssemblerDeps;
  private readonly state: Record<Direction, DirectionState> = { A: {}, B: {} };
  /** One counter for both directions, never reset, so ids are never reused (spec §5.2). */
  private seq = 0;

  constructor(deps: AssemblerDeps) {
    this.deps = deps;
  }

  /** Returns the created/updated entry copy, or undefined for an empty/whitespace delta with nothing to return. */
  onTranslateDelta(d: {
    direction: Direction;
    kind: 'input' | 'output';
    text: string;
  }): TranscriptEntry | undefined {
    if (d.text === '') return undefined;
    const now = this.deps.now();
    const st = this.state[d.direction];
    // A whitespace-only piece is the space between two words: keep it inside an open entry,
    // never let it start one.
    if (d.text.trim() === '' && !st.open) return undefined;

    if (!st.open && d.kind === 'output') {
      const late = this.tryAttachLate(st, d.text, now);
      if (late) return late;
    }

    let open = st.open;
    if (!open) {
      open = { entry: this.newEntry(d.direction, now) };
      st.open = open;
    }

    const entry = open.entry;
    if (d.kind === 'input') {
      entry.original = joinDelta(entry.original, d.text);
      open.lastInputAt = now;
    } else {
      entry.translated = joinDelta(entry.translated, d.text);
      open.lastOutputAt = now;
    }
    entry.updatedAt = now;

    if (this.isLongEntryDone(open, now)) return this.finalize(d.direction, now);
    return copy(entry);
  }

  /** Applies idle rules; returns entries that changed. */
  tick(): TranscriptEntry[] {
    const now = this.deps.now();
    const changed: TranscriptEntry[] = [];
    for (const dir of DIRECTIONS) {
      const open = this.state[dir].open;
      if (!open) continue;
      if (this.isIdleDone(open, now) || this.isLongEntryDone(open, now)) {
        changed.push(this.finalize(dir, now));
      }
    }
    return changed;
  }

  finalizeAll(): TranscriptEntry[] {
    const now = this.deps.now();
    const changed: TranscriptEntry[] = [];
    for (const dir of DIRECTIONS) {
      if (this.state[dir].open) changed.push(this.finalize(dir, now));
    }
    return changed;
  }

  /**
   * Forgets every open and recently finalized entry (used by "Clear transcript"): a late delta
   * must not re-insert a cleared entry or fire its onFinal again. The next delta starts a new
   * entry with a fresh id; ids stay unique because `seq` is not reset.
   */
  reset(): void {
    for (const dir of DIRECTIONS) {
      delete this.state[dir].open;
      delete this.state[dir].lastFinal;
    }
  }

  private newEntry(direction: Direction, now: number): TranscriptEntry {
    const { user, them } = this.deps.langs();
    const isMe = direction === 'A';
    this.seq += 1;
    return {
      id: `tr-${direction}-${this.seq}`,
      direction,
      speaker: speakerOf(direction),
      source: 'translate',
      original: '',
      translated: '',
      originalLang: isMe ? user : them,
      translatedLang: isMe ? them : user,
      startedAt: now,
      updatedAt: now,
      final: false,
    };
  }

  /**
   * Late output (spec §6.1): attach to the most recently finalized entry when it was finalized
   * less than LATE_OUTPUT_MS ago and has no translation yet. Further output deltas of the same late
   * translation keep attaching while each arrives within LATE_OUTPUT_MS of the previous one.
   */
  private tryAttachLate(
    st: DirectionState,
    text: string,
    now: number,
  ): TranscriptEntry | undefined {
    const last = st.lastFinal;
    if (!last) return undefined;
    const fresh =
      last.lateAt === undefined
        ? last.entry.translated === '' && now - last.finalizedAt < LATE_OUTPUT_MS
        : now - last.lateAt < LATE_OUTPUT_MS;
    if (!fresh) return undefined;
    last.entry.translated = joinDelta(last.entry.translated, text);
    last.entry.updatedAt = now;
    last.lateAt = now;
    return copy(last.entry);
  }

  private isIdleDone(open: OpenState, now: number): boolean {
    const lastActivity = Math.max(
      open.lastInputAt ?? Number.NEGATIVE_INFINITY,
      open.lastOutputAt ?? Number.NEGATIVE_INFINITY,
    );
    if (now - lastActivity < FINALIZE_IDLE_MS) return false;
    const { original, translated } = open.entry;
    const waiting =
      original !== '' &&
      translated === '' &&
      open.lastInputAt !== undefined &&
      now - open.lastInputAt < OUTPUT_LAG_MS;
    return !waiting;
  }

  private isLongEntryDone(open: OpenState, now: number): boolean {
    if (now - open.entry.startedAt < LONG_ENTRY_MS) return false;
    if (!SENTENCE_END_RE.test(open.entry.translated)) return false;
    return open.lastInputAt === undefined || now - open.lastInputAt >= FINALIZE_IDLE_MS;
  }

  private finalize(direction: Direction, now: number): TranscriptEntry {
    const st = this.state[direction];
    const open = st.open;
    if (!open) throw new Error('finalize without an open entry');
    open.entry.final = true;
    open.entry.updatedAt = now;
    st.lastFinal = { entry: open.entry, finalizedAt: now };
    delete st.open;
    return copy(open.entry);
  }
}
