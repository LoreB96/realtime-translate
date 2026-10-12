import { StrictMode, useEffect, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../shared/i18n/I18nProvider';
import type { Locale } from '../shared/i18n';
import { TranscriptWindow } from './views/transcript/TranscriptWindow';
import './styles/transcript.css';

function Root(): JSX.Element | null {
  const [locale, setLocale] = useState<Locale | null>(null);
  useEffect(() => {
    window.rt
      .resolveLocale()
      .then(setLocale)
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[i18n] resolveLocale failed, falling back to en-US', err);
        setLocale('en-US');
      });
  }, []);
  useEffect(() => {
    if (locale) document.documentElement.lang = locale;
  }, [locale]);
  if (!locale) return null;
  return (
    <I18nProvider locale={locale}>
      <TranscriptWindow />
    </I18nProvider>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('root not found');
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
