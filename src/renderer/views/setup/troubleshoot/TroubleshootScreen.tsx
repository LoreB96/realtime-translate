import { useState, type JSX } from 'react';
import { useT } from '../../../../shared/i18n/I18nProvider';
import type { TranslationKey } from '../../../../shared/i18n';
import type { DiagnosticCheck, DiagnosticsResult, HealthIssue } from '../../../../shared/types';
import { rt } from '../../../ipc/client';
import { useStore } from '../../../state/store';
import { useHealthSubscription } from '../../../state/useHealthSubscription';
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
} from '../../../state/healthText';
import { navigate } from '../shared/useHashRoute';
import { SetupTitlebar } from '../shared/SetupTitlebar';
import { CallDeviceNames } from '../shared/CallDeviceNames';
import { useCallDeviceLabels } from '../shared/useCallDeviceLabels';

type CheckRun =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: DiagnosticsResult }
  | { kind: 'busy' }
  | { kind: 'error'; message: string };

type GuideId = 'meet' | 'teams' | 'zoom' | 'windows';
const GUIDE_STEPS: Record<GuideId, number> = { meet: 6, teams: 5, zoom: 5, windows: 6 };
const FAQ_IDS = ['phantom', 'notHeard', 'echo', 'direct'] as const;

const STATUS_ICON: Record<DiagnosticCheck['status'], string> = {
  pass: '✓',
  warn: '!',
  fail: '✕',
  skipped: '–',
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * One place where a non-technical user can find out why audio doesn't work and how to fix
 * it: an automatic audio check, the problems main detects right now, step-by-step guides
 * per call app, and answers to the most common symptoms.
 */
export function TroubleshootScreen({ embedded = false }: { embedded?: boolean }): JSX.Element {
  const t = useT();
  useHealthSubscription();
  const health = useStore((s) => s.health);
  const labels = useCallDeviceLabels();
  const vars = { mic: labels.mic, speaker: labels.speaker };
  const [run, setRun] = useState<CheckRun>({ kind: 'idle' });

  const runCheck = async (): Promise<void> => {
    setRun({ kind: 'running' });
    try {
      const result = await rt.runDiagnostics();
      setRun({ kind: 'done', result });
    } catch (e) {
      if (isBusyTranslatingError(e)) {
        setRun({ kind: 'busy' });
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[troubleshoot] runDiagnostics failed', e);
      setRun({ kind: 'error', message: ipcErrorMessage(e) });
    }
  };

  const back = (): void => {
    // Opened from the bar/menu the screen is the first history entry; go to Settings then.
    if (window.history.length > 1) window.history.back();
    else navigate({ kind: 'settings', section: 'general' });
  };

  const running = run.kind === 'running';

  const sections = (
      <>
        {/* a) Automatic audio check */}
        <section className="trouble-section">
          <h2 className="trouble-section__title">{t('trouble.check.heading')}</h2>
          <p className="trouble-text">{t('trouble.check.intro')}</p>
          <div className="trouble-callout">{t('trouble.check.during')}</div>
          {health.mode === 'translating' && run.kind !== 'busy' && (
            <div className="trouble-banner trouble-banner--warning">{t('trouble.check.busy')}</div>
          )}
          <div className="trouble-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={running}
              onClick={(): void => { void runCheck(); }}
            >
              {run.kind === 'done' ? t('trouble.check.again') : t('trouble.check.run')}
            </button>
            {running && (
              <span className="trouble-running" role="status">
                <span className="trouble-spinner" aria-hidden="true" />
                {t('trouble.check.running')}
              </span>
            )}
          </div>

          {run.kind === 'busy' && (
            <div className="trouble-banner trouble-banner--warning" role="alert">{t('trouble.check.busy')}</div>
          )}
          {run.kind === 'error' && (
            <div className="trouble-banner trouble-banner--error" role="alert">
              {t('trouble.check.failed', { message: run.message })}
            </div>
          )}
          {run.kind === 'done' && (
            <DiagnosticsList result={run.result} vars={vars} />
          )}
        </section>

        {/* b) Problems main is detecting right now */}
        <section className="trouble-section">
          <h2 className="trouble-section__title">{t('trouble.live.heading')}</h2>
          <p className="trouble-text trouble-text--muted">{t(`trouble.live.mode.${health.mode}`)}</p>
          {health.issues.length === 0 ? (
            <div className="trouble-banner trouble-banner--ok">{t('trouble.live.none')}</div>
          ) : (
            <div className="trouble-list">
              {health.issues.map((issue) => (
                <LiveIssue key={`${issue.code}:${issue.role}`} issue={issue} vars={vars} />
              ))}
            </div>
          )}
        </section>

        {/* c) Step-by-step guides per call app + Windows */}
        <section className="trouble-section">
          <h2 className="trouble-section__title">{t('trouble.guides.heading')}</h2>
          <CallDeviceNames mic={labels.mic} speaker={labels.speaker} heading={t('trouble.guides.devicesIntro')} />
          {(Object.keys(GUIDE_STEPS) as GuideId[]).map((id) => (
            <details key={id} className="trouble-details">
              <summary>{t(`trouble.guides.${id}.title`)}</summary>
              <ol className="trouble-steps">
                {Array.from({ length: GUIDE_STEPS[id] }, (_, i) => (
                  <li key={i}>{t(`trouble.guides.${id}.step${i + 1}` as TranslationKey, vars)}</li>
                ))}
              </ol>
            </details>
          ))}
        </section>

        {/* d) FAQ */}
        <section className="trouble-section">
          <h2 className="trouble-section__title">{t('trouble.faq.heading')}</h2>
          {FAQ_IDS.map((id) => (
            <details key={id} className="trouble-details">
              <summary>{t(`trouble.faq.${id}.q`)}</summary>
              <p className="trouble-text">{t(`trouble.faq.${id}.a`, vars)}</p>
            </details>
          ))}
        </section>
      </>
  );

  // Inside Settings the section header and navigation come from the Settings shell.
  if (embedded) return sections;

  return (
    <div className="setup-shell">
      <SetupTitlebar titleSuffix={t('trouble.heading')} />
      <div className="setup-body">
        <h1 className="setup-heading">{t('trouble.heading')}</h1>
        <p className="setup-sub">{t('trouble.sub')}</p>
        {sections}
        <div className="setup-footer">
          <button className="btn btn-ghost" onClick={back}>{t('trouble.back')}</button>
          <button className="btn btn-primary" onClick={(): void => window.close()}>
            {t('review.footer.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function DiagnosticsList({
  result, vars,
}: {
  result: DiagnosticsResult;
  vars: Record<string, string>;
}): JSX.Element {
  const t = useT();
  const allPass = result.checks.length > 0 && result.checks.every((c) => c.status === 'pass');
  return (
    <div className="trouble-results">
      <div className="trouble-text trouble-text--muted">
        {t('trouble.check.finishedAt', { time: formatTime(result.finishedMs) })}
      </div>
      {allPass && <div className="trouble-banner trouble-banner--ok">{t('trouble.check.allPass')}</div>}
      <div className="trouble-list">
        {result.checks.map((check) => {
          const db = formatDb(check.measuredDb);
          return (
            <div key={check.id} className={`diag-row diag-row--${check.status}`} title={check.detail}>
              <span className={`diag-icon diag-icon--${check.status}`} aria-hidden="true">
                {STATUS_ICON[check.status]}
              </span>
              <div className="diag-body">
                <div className="diag-head">
                  <span className="diag-title">{t(diagTitleKey(check.id))}</span>
                  <span className={`diag-status diag-status--${check.status}`}>
                    {t(`trouble.check.status.${check.status}`)}
                  </span>
                  {db !== undefined && <span className="diag-db">{t('trouble.check.level', { db })}</span>}
                </div>
                {checkNeedsFix(check) && <div className="diag-fix">{t(diagFixKey(check.id), vars)}</div>}
                {check.status === 'skipped' && <div className="diag-hint">{t('trouble.check.skippedHint')}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LiveIssue({ issue, vars }: { issue: HealthIssue; vars: Record<string, string> }): JSX.Element {
  const t = useT();
  const severity = issueSeverity(issue);
  const status = severity === 'error' ? 'fail' : 'warn';
  return (
    <div className={`diag-row diag-row--${status}`} title={issue.detail}>
      <span className={`diag-icon diag-icon--${status}`} aria-hidden="true">{STATUS_ICON[status]}</span>
      <div className="diag-body">
        <div className="diag-head">
          <span className="diag-title">{t(issueShortKey(issue))}</span>
          <span className="diag-db">{t('trouble.live.since', { time: formatTime(issue.sinceMs) })}</span>
        </div>
        <div className="diag-fix">{t(issueFixKey(issue), vars)}</div>
      </div>
    </div>
  );
}
