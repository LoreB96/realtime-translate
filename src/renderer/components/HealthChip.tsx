import { useEffect, useState, type JSX } from 'react';
import type { HealthReport } from '../../shared/types';
import { useT } from '../../shared/i18n/I18nProvider';
import { rt } from '../ipc/client';
import { issueFixKey, issueSeverity, issueShortKey, primaryIssue } from '../state/healthText';
import { callDeviceLabels } from '../views/setup/shared/cables';

/**
 * Compact audio-health indicator for the floating bar.
 * - With an issue: amber/red chip with a short label; the tooltip carries the full fix and
 *   a click opens the troubleshooting screen.
 * - Without issues in direct (passthrough) mode while idle: a subtle "Direct audio" label,
 *   so the user knows the call is flowing untranslated on purpose.
 */
export function HealthChip({ health, idle }: { health: HealthReport; idle: boolean }): JSX.Element | null {
  const t = useT();
  const issue = primaryIssue(health);
  const [labels, setLabels] = useState(() => callDeviceLabels(undefined));

  // Fix texts quote the exact CABLE names the call app must use. Fetch the real labels
  // only when there's something to explain; fall back to the stock names on failure.
  const issueCode = issue?.code;
  useEffect(() => {
    if (!issueCode) return;
    let alive = true;
    rt.listDevices()
      .then((inv) => { if (alive) setLabels(callDeviceLabels(inv)); })
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[health-chip] listDevices failed, using default cable names', e);
      });
    return (): void => { alive = false; };
  }, [issueCode]);

  if (issue) {
    const severity = issueSeverity(issue);
    const short = t(issueShortKey(issue));
    const fix = t(issueFixKey(issue), { mic: labels.mic, speaker: labels.speaker });
    const tooltip = `${short}\n\n${fix}\n\n${t('bar.health.clickForHelp')}`;
    return (
      <button
        type="button"
        className={`rt-health rt-health--${severity}`}
        title={tooltip}
        aria-label={`${short}. ${fix}`}
        onClick={(): void => { void rt.openTroubleshooting(); }}
      >
        <svg className="rt-health__icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {severity === 'error' ? (
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5.5M12 16.5h.01" />
            </>
          ) : (
            <>
              <path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              <path d="M12 9v4M12 17h.01" />
            </>
          )}
        </svg>
        <span className="rt-health__label">{short}</span>
      </button>
    );
  }

  if (idle && health.mode === 'passthrough') {
    return (
      <span className="rt-health rt-health--direct" title={t('bar.health.directTooltip')}>
        <span className="rt-health__label">{t('bar.health.direct')}</span>
      </span>
    );
  }

  return null;
}
