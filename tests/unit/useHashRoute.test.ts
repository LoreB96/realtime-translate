import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  navigate,
  parseHashRoute,
  routeToHash,
  SETTINGS_SECTIONS,
  type HashRoute,
} from '@renderer/views/setup/shared/useHashRoute';

describe('parseHashRoute', () => {
  it('parses #/wizard/N with valid step', () => {
    expect(parseHashRoute('#/wizard/1')).toEqual<HashRoute>({ kind: 'wizard', step: 1 });
    expect(parseHashRoute('#/wizard/6')).toEqual<HashRoute>({ kind: 'wizard', step: 6 });
  });

  it('parses #/wizard/N?mode=edit', () => {
    expect(parseHashRoute('#/wizard/2?mode=edit')).toEqual<HashRoute>({
      kind: 'wizard',
      step: 2,
      mode: 'edit',
    });
  });

  it('parses every #/settings/<section>', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(parseHashRoute(`#/settings/${section}`)).toEqual<HashRoute>({
        kind: 'settings',
        section,
      });
    }
  });

  it('opens General for #/settings and unknown sections', () => {
    expect(parseHashRoute('#/settings')).toEqual<HashRoute>({ kind: 'settings', section: 'general' });
    expect(parseHashRoute('#/settings/nope')).toEqual<HashRoute>({
      kind: 'settings',
      section: 'general',
    });
  });

  it('maps the legacy routes into Settings', () => {
    expect(parseHashRoute('#/review')).toEqual<HashRoute>({ kind: 'settings', section: 'general' });
    expect(parseHashRoute('#/assistant')).toEqual<HashRoute>({
      kind: 'settings',
      section: 'transcription',
    });
    expect(parseHashRoute('#/assistant?from=transcript')).toEqual<HashRoute>({
      kind: 'settings',
      section: 'transcription',
    });
  });

  it('keeps the standalone troubleshooting screen used by the wizard', () => {
    expect(parseHashRoute('#/troubleshoot')).toEqual<HashRoute>({ kind: 'troubleshoot' });
    expect(parseHashRoute('#/troubleshoot?from=widget')).toEqual<HashRoute>({
      kind: 'troubleshoot',
    });
  });

  it('rejects out-of-range steps', () => {
    expect(parseHashRoute('#/wizard/0')).toEqual<HashRoute>({ kind: 'wizard', step: 1 });
    expect(parseHashRoute('#/wizard/7')).toEqual<HashRoute>({ kind: 'wizard', step: 1 });
    expect(parseHashRoute('#/wizard/abc')).toEqual<HashRoute>({ kind: 'wizard', step: 1 });
  });

  it('falls back to wizard step 1 on empty/unknown hash', () => {
    expect(parseHashRoute('')).toEqual<HashRoute>({ kind: 'wizard', step: 1 });
    expect(parseHashRoute('#/garbage')).toEqual<HashRoute>({ kind: 'wizard', step: 1 });
    expect(parseHashRoute('#/assistants')).toEqual<HashRoute>({ kind: 'wizard', step: 1 });
  });
});

describe('navigate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = (route: HashRoute): string => {
    const location = { hash: '' };
    vi.stubGlobal('window', { location });
    navigate(route);
    return location.hash;
  };

  it('writes settings routes that round-trip through parseHashRoute', () => {
    for (const section of SETTINGS_SECTIONS) {
      const hash = run({ kind: 'settings', section });
      expect(hash).toBe(`#/settings/${section}`);
      expect(parseHashRoute(hash)).toEqual<HashRoute>({ kind: 'settings', section });
    }
  });

  it('writes wizard and troubleshoot routes', () => {
    expect(run({ kind: 'troubleshoot' })).toBe('#/troubleshoot');
    expect(run({ kind: 'wizard', step: 2, mode: 'edit' })).toBe('#/wizard/2?mode=edit');
    expect(routeToHash({ kind: 'wizard', step: 4 })).toBe('#/wizard/4');
  });
});
