import { describe, it, expect } from 'vitest';
import { createT, getDictionary, SUPPORTED_LOCALES } from '@shared/i18n';
import type {
  DeviceRole,
  DiagnosticCheckId,
  HealthIssue,
  HealthIssueCode,
} from '@shared/types';
import {
  checkNeedsFix,
  diagFixKey,
  diagTitleKey,
  formatDb,
  ipcErrorMessage,
  isBusyTranslatingError,
  issueFixKey,
  issueSeverity,
  issueShortKey,
  primaryIssue,
} from '@renderer/state/healthText';

const CODES: HealthIssueCode[] = [
  'device-missing', 'device-failed', 'mic-silent', 'call-silent', 'audio-suspended', 'mic-quiet', 'call-quiet',
];
const ROLES: DeviceRole[] = ['mic', 'toCall', 'fromCall', 'headset'];
const CHECK_IDS: DiagnosticCheckId[] = [
  'api-key', 'devices-saved', 'mic-present', 'mic-signal', 'to-call-present',
  'cable-a-loopback', 'from-call-present', 'call-signal', 'headset-present', 'headset-tone',
];

const issue = (code: HealthIssueCode, role: DeviceRole = 'mic'): HealthIssue => ({ code, role, sinceMs: 0 });

describe('healthText', () => {
  it('classifies device/suspend problems as errors and silence as warnings', () => {
    expect(issueSeverity(issue('device-missing'))).toBe('error');
    expect(issueSeverity(issue('device-failed'))).toBe('error');
    expect(issueSeverity(issue('audio-suspended'))).toBe('error');
    expect(issueSeverity(issue('mic-silent'))).toBe('warning');
    expect(issueSeverity(issue('call-silent', 'fromCall'))).toBe('warning');
    expect(issueSeverity(issue('mic-quiet'))).toBe('warning');
    expect(issueSeverity(issue('call-quiet', 'fromCall'))).toBe('warning');
  });

  it('words device problems per role', () => {
    expect(issueShortKey(issue('device-missing', 'headset'))).toBe('health.short.device-missing.headset');
    expect(issueFixKey(issue('device-failed', 'toCall'))).toBe('health.fix.device-failed.toCall');
    expect(issueShortKey(issue('call-silent', 'fromCall'))).toBe('health.short.call-silent');
  });

  // Guards against a key being renamed in JSON but not in the mapping: a miss would
  // render the raw key path in the UI.
  it.each(SUPPORTED_LOCALES)('every issue and check maps to a real string in %s', (loc) => {
    const t = createT(getDictionary(loc));
    for (const code of CODES) {
      for (const role of ROLES) {
        const short = issueShortKey(issue(code, role));
        const fix = issueFixKey(issue(code, role));
        expect(t(short)).not.toBe(short);
        expect(t(fix)).not.toBe(fix);
      }
    }
    for (const id of CHECK_IDS) {
      expect(t(diagTitleKey(id))).not.toBe(diagTitleKey(id));
      expect(t(diagFixKey(id))).not.toBe(diagFixKey(id));
    }
  });

  it('substitutes the exact speaker name into the call-silent fix', () => {
    const t = createT(getDictionary('en-US'));
    const text = t(issueFixKey(issue('call-silent', 'fromCall')), { mic: 'M', speaker: 'CABLE-B Input (X)' });
    expect(text).toContain('"CABLE-B Input (X)"');
    expect(text).not.toContain('{{');
  });

  it('primaryIssue prefers the first error, else the first issue', () => {
    expect(primaryIssue(undefined)).toBeUndefined();
    expect(primaryIssue({ mode: 'off', issues: [] })).toBeUndefined();
    const silent = issue('call-silent', 'fromCall');
    const missing = issue('device-missing', 'headset');
    expect(primaryIssue({ mode: 'translating', issues: [silent, missing] })).toBe(missing);
    expect(primaryIssue({ mode: 'translating', issues: [silent] })).toBe(silent);
  });

  it('shows fixes only for warn/fail checks', () => {
    expect(checkNeedsFix({ status: 'warn' })).toBe(true);
    expect(checkNeedsFix({ status: 'fail' })).toBe(true);
    expect(checkNeedsFix({ status: 'pass' })).toBe(false);
    expect(checkNeedsFix({ status: 'skipped' })).toBe(false);
  });

  it('formats dB values and drops non-finite ones', () => {
    expect(formatDb(-42.4)).toBe('-42');
    expect(formatDb(undefined)).toBeUndefined();
    expect(formatDb(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(formatDb(Number.NaN)).toBeUndefined();
  });

  it('recognises the busy-translating rejection through the Electron IPC wrapper', () => {
    const wrapped = new Error("Error invoking remote method 'health:runDiagnostics': Error: busy-translating");
    expect(isBusyTranslatingError(wrapped)).toBe(true);
    expect(isBusyTranslatingError(new Error('timeout'))).toBe(false);
    expect(isBusyTranslatingError('busy-translating')).toBe(true);
  });

  it('strips the Electron IPC wrapper from error messages', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'health:runDiagnostics': Error: offscreen timeout")))
      .toBe('offscreen timeout');
    expect(ipcErrorMessage(new Error("Error invoking remote method 'x': TypeError: bad"))).toBe('bad');
    expect(ipcErrorMessage(new Error('plain'))).toBe('plain');
    expect(ipcErrorMessage(new Error(''))).toBe('unknown error');
  });
});
