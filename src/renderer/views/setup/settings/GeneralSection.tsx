import { useEffect, useState, type JSX } from 'react';
import { useT } from '../../../../shared/i18n/I18nProvider';
import { LANGUAGES, type LanguageCode } from '../../../../shared/languages';
import { rt } from '../../../ipc/client';
import { useStore } from '../../../state/store';

function logError(what: string, e: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[settings] ${what} failed`, e);
}

/** Call languages and the OpenAI key. Every change saves immediately. */
export function GeneralSection(): JSX.Element {
  const t = useT();
  const { sourceLang, targetLang, setSourceLang, setTargetLang } = useStore();
  const [hint, setHint] = useState<string | undefined>();
  const [hasKey, setHasKey] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    rt.hasApiKey().then(setHasKey).catch((e: unknown) => logError('hasApiKey', e));
    rt.getApiKeyHint().then(setHint).catch((e: unknown) => logError('getApiKeyHint', e));
  }, []);

  const saveKey = async (): Promise<void> => {
    setError(undefined);
    // Pasted keys often carry a trailing newline/space, which would be rejected (401).
    const key = draft.trim();
    if (!key.startsWith('sk-')) {
      setError(t('setup.key.invalidPrefix'));
      return;
    }
    try {
      await rt.setApiKey(key);
      setHasKey(true);
      setHint(key.slice(-4));
      setDraft('');
      setEditing(false);
    } catch (e) {
      setError(t('setup.key.saveError', { message: (e as Error).message }));
    }
  };

  const showInput = !hasKey || editing;

  return (
    <>
      <section className="trouble-section">
        <h2 className="trouble-section__title">{t('settings.general.languages')}</h2>
        <div className="settings-lang">
          <label className="settings-lang__field">
            <span className="setup-field-label">{t('settings.general.you')}</span>
            <select
              className="setup-input"
              value={sourceLang}
              onChange={(e): void => setSourceLang(e.target.value as LanguageCode)}
            >
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </label>
          <span className="settings-lang__arrow" aria-hidden="true">⇄</span>
          <label className="settings-lang__field">
            <span className="setup-field-label">{t('settings.general.them')}</span>
            <select
              className="setup-input"
              value={targetLang}
              onChange={(e): void => setTargetLang(e.target.value as LanguageCode)}
            >
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </label>
        </div>
        <div className="setup-field-hint">{t('settings.general.languagesHint')}</div>
      </section>

      <section className="trouble-section">
        <h2 className="trouble-section__title">{t('settings.general.key')}</h2>
        {!showInput ? (
          <div className="settings-row">
            <span className="settings-status settings-status--ok">
              {t('settings.general.keySaved', { last4: hint ?? '●●●●' })}
            </span>
            <button type="button" className="btn btn-secondary" onClick={(): void => setEditing(true)}>
              {t('settings.general.keyReplace')}
            </button>
          </div>
        ) : (
          <>
            {!hasKey && (
              <div className="settings-status settings-status--warn">{t('settings.general.keyMissing')}</div>
            )}
            <div className="assist-row">
              <input
                className="setup-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft}
                placeholder={t('setup.key.placeholder')}
                onChange={(e): void => setDraft(e.target.value)}
                onKeyDown={(e): void => {
                  if (e.key === 'Enter') void saveKey();
                }}
              />
              <button
                type="button"
                className="btn btn-primary assist-btn-nowrap"
                disabled={draft.trim() === ''}
                onClick={(): void => { void saveKey(); }}
              >
                {t('common.save')}
              </button>
              {hasKey && (
                <button
                  type="button"
                  className="btn btn-ghost assist-btn-nowrap"
                  onClick={(): void => { setEditing(false); setDraft(''); setError(undefined); }}
                >
                  {t('common.cancel')}
                </button>
              )}
            </div>
          </>
        )}
        {error && <div className="assist-inline-error" role="alert">{error}</div>}
        <div className="setup-field-hint">{t('settings.general.keyHint')}</div>
        <button
          type="button"
          className="settings-link"
          onClick={(): void => { void rt.openExternalUrl('https://platform.openai.com/api-keys'); }}
        >
          {t('setup.key.signupLink')}
        </button>
      </section>
    </>
  );
}
