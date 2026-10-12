import ptBR from './locales/pt-BR.json';
import enUS from './locales/en-US.json';
import itIT from './locales/it-IT.json';
import type { Locale, TranslationDict, TranslationKey } from './types';

export type { Locale, TranslationDict, TranslationKey };
export { ptBR, enUS, itIT };

export const SUPPORTED_LOCALES: readonly Locale[] = ['pt-BR', 'en-US', 'it-IT'];

const DICTIONARIES: Record<Locale, TranslationDict> = {
  'pt-BR': ptBR,
  'en-US': enUS,
  'it-IT': itIT,
};

/** Walk a dot-notation path through the dict; return the key itself on miss
 *  (intentionally — makes missing translations visible in the UI). */
function lookup(dict: TranslationDict, path: string): string {
  const parts = path.split('.');
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return path;
    }
  }
  return typeof cur === 'string' ? cur : path;
}

function substitute(template: string, vars: Record<string, string | number> | undefined): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined ? `{{${key}}}` : String(v);
  });
}

export type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** Build a `t()` function bound to a specific dictionary. Used by useT in the renderer. */
export function createT(dict: TranslationDict): T {
  return (key, vars) => substitute(lookup(dict, key as string), vars);
}

/**
 * Pick the first supported locale in `candidates`; fall back to en-US.
 * Exact matches win over language-prefix matches across the whole list, so
 * ['en-GB', 'pt-BR'] resolves to pt-BR (exact) rather than en-US (prefix of en-GB).
 * Prefix matching maps OS locales like 'it', 'it-CH', 'pt-PT', 'en-GB' to the
 * supported variant of the same language.
 */
export function resolveLocaleFromCandidates(candidates: readonly string[]): Locale {
  for (const c of candidates) {
    if ((SUPPORTED_LOCALES as readonly string[]).includes(c)) return c as Locale;
  }
  for (const c of candidates) {
    const lang = c.split(/[-_]/)[0]?.toLowerCase();
    if (!lang) continue;
    const match = SUPPORTED_LOCALES.find((l) => l.split('-')[0] === lang);
    if (match) return match;
  }
  return 'en-US';
}

export function getDictionary(locale: Locale): TranslationDict {
  return DICTIONARIES[locale];
}
