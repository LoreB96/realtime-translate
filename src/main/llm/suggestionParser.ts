/**
 * Tolerant parser for reply suggestions (spec §6.3). Pure.
 * Order: code-fence strip → JSON.parse → balanced-brace scan → numbered/bulleted lines.
 * Accepts `{"suggestions":[…]}`, a bare array of objects or strings; drops empty text;
 * keeps at most 3. Every kept suggestion passes isSpeakArgs: text longer than MAX_SPEAK_CHARS
 * is dropped, and a translation longer than MAX_TTS_INPUT_CHARS is blanked (Speak then
 * translates the text itself).
 */
import { MAX_SPEAK_CHARS, MAX_TTS_INPUT_CHARS, type Suggestion } from '../../shared/assistant';

export const MAX_SUGGESTIONS = 3;

const FENCE_RE = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/;
const LIST_LINE_RE = /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function normalize(items: unknown[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const it of items) {
    let text: unknown;
    let translation: unknown = '';
    if (typeof it === 'string') {
      text = it;
    } else if (isObject(it)) {
      text = it.text;
      translation = it.translation;
    }
    if (typeof text !== 'string') continue;
    const t = text.trim();
    if (t === '' || t.length > MAX_SPEAK_CHARS) continue;
    const tr = typeof translation === 'string' ? translation.trim() : '';
    out.push({ text: t, translation: tr.length > MAX_TTS_INPUT_CHARS ? '' : tr });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

/** Suggestions from a parsed JSON value, or undefined when the shape is not recognised. */
function fromJson(v: unknown): Suggestion[] | undefined {
  if (Array.isArray(v)) return normalize(v);
  if (isObject(v) && Array.isArray(v.suggestions)) return normalize(v.suggestions);
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

/** End index (exclusive) of the balanced `{…}` / `[…]` starting at `start`, string-aware. */
function balancedEnd(s: string, start: number): number | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return undefined;
      if (stack.length === 0) return i + 1;
    }
  }
  return undefined;
}

function scanBraces(s: string): Suggestion[] | undefined {
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = balancedEnd(s, i);
    if (end === undefined) continue;
    const parsed = fromJson(tryParse(s.slice(i, end)));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function stripQuotes(s: string): string {
  return s
    .trim()
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^["“](.*)["”]$/, '$1')
    .trim();
}

function fromListLines(s: string): Suggestion[] {
  const items: string[] = [];
  for (const line of s.split(/\r?\n/)) {
    const m = LIST_LINE_RE.exec(line);
    if (m?.[1]) items.push(stripQuotes(m[1]));
  }
  return normalize(items);
}

export function parseSuggestions(raw: string): Suggestion[] {
  let s = raw.trim();
  const fence = FENCE_RE.exec(s);
  if (fence?.[1] !== undefined) s = fence[1].trim();
  if (s === '') return [];
  const direct = fromJson(tryParse(s));
  if (direct !== undefined) return direct;
  const scanned = scanBraces(s);
  if (scanned !== undefined) return scanned;
  return fromListLines(s);
}
