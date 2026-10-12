import type { JSX } from 'react';
import type { AssistantContext } from '../../../shared/assistant';
import { useT } from '../../../shared/i18n/I18nProvider';
import { rt } from '../../ipc/client';

/** Shown when not translating and transcription is off (spec §11.1 item 2). M7 adds "local". */
export function SttCta({ context }: { context: AssistantContext }): JSX.Element {
  const t = useT();
  const disabled = !context.hasOpenAiKey;
  return (
    <section className="tr-cta">
      <p className="tr-cta__title">{t('transcript.cta.title')}</p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={disabled}
        onClick={(): void => {
          rt.setAssistantPrefs({ sttEngine: 'openai' }).catch((e: unknown) => {
            // eslint-disable-next-line no-console
            console.warn('[transcript] setAssistantPrefs failed', e);
          });
        }}
      >
        {t('transcript.cta.openai')}
      </button>
      {disabled && <p className="tr-hint tr-hint--warn">{t('transcript.composer.noKey')}</p>}
      <p className="tr-hint">{t('transcript.cta.hint')}</p>
    </section>
  );
}
