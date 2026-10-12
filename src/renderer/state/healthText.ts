import type { TranslationKey } from '../../shared/i18n';
import type {
  DiagnosticCheck,
  DiagnosticCheckId,
  HealthIssue,
  HealthReport,
} from '../../shared/types';

/**
 * Pure mapping from health issues / diagnostic checks to i18n keys and severities.
 * Kept free of React so it can be unit-tested and shared by the widget chip and the
 * troubleshooting screen.
 */

export type IssueSeverity = 'error' | 'warning';

/**
 * A missing/failed device or a suspended audio context stops a direction outright (red).
 * Silence / a too-quiet source is usually a setting in the call app, a volume slider or
 * a mute button (amber).
 */
export function issueSeverity(issue: Pick<HealthIssue, 'code'>): IssueSeverity {
  switch (issue.code) {
    case 'device-missing':
    case 'device-failed':
    case 'audio-suspended':
      return 'error';
    case 'mic-silent':
    case 'call-silent':
    case 'mic-quiet':
    case 'call-quiet':
      return 'warning';
  }
}

/** Short (chip-sized) label for an issue. Device problems are worded per role. */
export function issueShortKey(issue: Pick<HealthIssue, 'code' | 'role'>): TranslationKey {
  switch (issue.code) {
    case 'device-missing':
    case 'device-failed':
      return `health.short.${issue.code}.${issue.role}`;
    case 'mic-silent':
    case 'call-silent':
    case 'audio-suspended':
    case 'mic-quiet':
    case 'call-quiet':
      return `health.short.${issue.code}`;
  }
}

/** Full "what is wrong + how to fix it" text for an issue. */
export function issueFixKey(issue: Pick<HealthIssue, 'code' | 'role'>): TranslationKey {
  switch (issue.code) {
    case 'device-missing':
    case 'device-failed':
      return `health.fix.${issue.code}.${issue.role}`;
    case 'mic-silent':
    case 'call-silent':
    case 'audio-suspended':
    case 'mic-quiet':
    case 'call-quiet':
      return `health.fix.${issue.code}`;
  }
}

/**
 * The issue the widget chip shows. Main sorts issues most-severe first; we still pick
 * the first 'error' defensively so a red problem is never hidden behind an amber one.
 */
export function primaryIssue(report: HealthReport | undefined): HealthIssue | undefined {
  const issues = report?.issues ?? [];
  return issues.find((i) => issueSeverity(i) === 'error') ?? issues[0];
}

export function diagTitleKey(id: DiagnosticCheckId): TranslationKey {
  return `trouble.diag.${id}.title`;
}

export function diagFixKey(id: DiagnosticCheckId): TranslationKey {
  return `trouble.diag.${id}.fix`;
}

/** Fix text is only shown for checks that need the user's attention. */
export function checkNeedsFix(check: Pick<DiagnosticCheck, 'status'>): boolean {
  return check.status === 'warn' || check.status === 'fail';
}

/** Format a dBFS measurement for display ("-42"); undefined/NaN → undefined. */
export function formatDb(db: number | undefined): string | undefined {
  if (db === undefined || !Number.isFinite(db)) return undefined;
  return String(Math.round(db));
}

/**
 * Electron wraps errors thrown by an ipcMain.handle handler as
 * "Error invoking remote method '<channel>': Error: <message>", so match on the
 * message text instead of the error identity.
 */
export function isBusyTranslatingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('busy-translating');
}

/** Strip Electron's IPC wrapper so the user sees only the underlying reason. */
export function ipcErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/^Error invoking remote method '[^']*': (?:\w*Error: )?(.*)$/s);
  return (m?.[1] ?? msg).trim() || 'unknown error';
}
