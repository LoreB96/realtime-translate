import { useEffect, useState } from 'react';

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

/** Sections of the Settings window (left navigation), in display order. */
export const SETTINGS_SECTIONS = [
  'general',
  'audio',
  'test',
  'transcription',
  'ai',
  'voice',
  'suggestions',
  'troubleshoot',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type HashRoute =
  | { kind: 'wizard'; step: WizardStep; mode?: 'edit' }
  | { kind: 'settings'; section: SettingsSection }
  /** Standalone troubleshooting screen, reachable from the first-run wizard. */
  | { kind: 'troubleshoot' };

export type WizardRoute = Extract<HashRoute, { kind: 'wizard' }>;

const STEP_VALUES = [1, 2, 3, 4, 5, 6] as const;

/** Routes of older builds, still opened by links and saved window state. */
const LEGACY: Record<string, SettingsSection> = {
  review: 'general',
  assistant: 'transcription',
};

function isSection(v: string | undefined): v is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(v ?? '');
}

export function parseHashRoute(hash: string): HashRoute {
  // Examples: '#/wizard/3', '#/wizard/2?mode=edit', '#/settings/audio', '#/troubleshoot'
  const m = hash.match(/^#\/(wizard|settings|review|troubleshoot|assistant)(?:\/(\w+))?(?:\?(.+))?$/);
  if (!m) return { kind: 'wizard', step: 1 };
  const [, kind, sub, query] = m;
  if (kind === 'settings') {
    return { kind: 'settings', section: isSection(sub) ? sub : 'general' };
  }
  const legacy = LEGACY[kind ?? ''];
  if (legacy) return { kind: 'settings', section: legacy };
  if (kind === 'troubleshoot') return { kind: 'troubleshoot' };
  const step = Number(sub);
  if (!STEP_VALUES.includes(step as WizardStep)) return { kind: 'wizard', step: 1 };
  const params = new URLSearchParams(query ?? '');
  const mode = params.get('mode') === 'edit' ? 'edit' : undefined;
  return mode ? { kind: 'wizard', step: step as WizardStep, mode } : { kind: 'wizard', step: step as WizardStep };
}

export function routeToHash(route: HashRoute): string {
  if (route.kind === 'settings') return `#/settings/${route.section}`;
  if (route.kind === 'troubleshoot') return '#/troubleshoot';
  return `#/wizard/${route.step}${route.mode === 'edit' ? '?mode=edit' : ''}`;
}

export function navigate(route: HashRoute): void {
  window.location.hash = routeToHash(route);
}

export function useHashRoute(): HashRoute {
  const [route, setRoute] = useState<HashRoute>(() => parseHashRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseHashRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    // A legacy hash ('#/review', '#/assistant') is rewritten to its Settings route so main
    // sees which section is open (it decides from the hash whether call audio may run).
    const canonical = routeToHash(parseHashRoute(window.location.hash));
    if (window.location.hash !== '' && window.location.hash !== canonical) {
      window.location.replace(canonical);
    }
    return (): void => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
