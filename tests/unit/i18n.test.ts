import { describe, it, expect } from 'vitest';
import { createT, getDictionary, resolveLocaleFromCandidates, SUPPORTED_LOCALES } from '@shared/i18n';

const fakeStrings = {
  greeting: 'Hello {{name}}',
  nested: {
    welcome: 'Welcome',
    cost: 'Cost: ${{amount}}',
  },
};

describe('i18n', () => {
  it('createT looks up nested keys with dot notation', () => {
    const t = createT(fakeStrings as never);
    expect(t('nested.welcome')).toBe('Welcome');
  });

  it('createT substitutes {{var}} placeholders', () => {
    const t = createT(fakeStrings as never);
    expect(t('greeting', { name: 'Gabriel' })).toBe('Hello Gabriel');
    expect(t('nested.cost', { amount: '0.42' })).toBe('Cost: $0.42');
  });

  it('createT returns the key itself on miss (visible debugging)', () => {
    const t = createT(fakeStrings as never);
    expect(t('does.not.exist' as never)).toBe('does.not.exist');
  });

  it('resolveLocaleFromCandidates picks first supported', () => {
    expect(resolveLocaleFromCandidates(['pt-BR', 'fr-FR'])).toBe('pt-BR');
    expect(resolveLocaleFromCandidates(['fr-FR', 'en-US'])).toBe('en-US');
  });

  it('resolveLocaleFromCandidates falls back to en-US on no match', () => {
    expect(resolveLocaleFromCandidates(['fr-FR', 'es-ES'])).toBe('en-US');
    expect(resolveLocaleFromCandidates([])).toBe('en-US');
  });

  it('resolveLocaleFromCandidates matches by language prefix after exact matches', () => {
    expect(resolveLocaleFromCandidates(['it'])).toBe('it-IT');
    expect(resolveLocaleFromCandidates(['it-CH'])).toBe('it-IT');
    expect(resolveLocaleFromCandidates(['pt'])).toBe('pt-BR');
    expect(resolveLocaleFromCandidates(['pt-PT'])).toBe('pt-BR');
    expect(resolveLocaleFromCandidates(['en-GB'])).toBe('en-US');
    expect(resolveLocaleFromCandidates(['IT_it'])).toBe('it-IT');
    // An exact match anywhere in the list beats a prefix match earlier in the list.
    expect(resolveLocaleFromCandidates(['en-GB', 'it-IT'])).toBe('it-IT');
    expect(resolveLocaleFromCandidates(['fr-FR', 'it-CH', 'en-GB'])).toBe('it-IT');
  });

  it('SUPPORTED_LOCALES lists pt-BR, en-US and it-IT', () => {
    expect(SUPPORTED_LOCALES).toEqual(['pt-BR', 'en-US', 'it-IT']);
  });
});

/** Flatten a locale dict into { 'a.b.c': 'value' }. */
function flatten(obj: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[path] = v;
    else Object.assign(out, flatten(v, path));
  }
  return out;
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? '').sort();
}

describe('locale dictionaries', () => {
  const reference = flatten(getDictionary('en-US'));

  it.each(SUPPORTED_LOCALES)('%s has exactly the same keys as en-US', (loc) => {
    const keys = Object.keys(flatten(getDictionary(loc))).sort();
    expect(keys).toEqual(Object.keys(reference).sort());
  });

  it.each(SUPPORTED_LOCALES)('%s uses the same {{placeholders}} as en-US for every key', (loc) => {
    const dict = flatten(getDictionary(loc));
    for (const [key, value] of Object.entries(reference)) {
      expect({ key, vars: placeholders(dict[key] ?? '') }).toEqual({ key, vars: placeholders(value) });
    }
  });

  it.each(SUPPORTED_LOCALES)('%s has no empty strings', (loc) => {
    for (const [key, value] of Object.entries(flatten(getDictionary(loc)))) {
      expect({ key, empty: value.trim() === '' }).toEqual({ key, empty: false });
    }
  });
});
