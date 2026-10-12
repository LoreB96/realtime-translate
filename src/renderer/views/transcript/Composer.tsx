import { useState, type JSX, type KeyboardEvent } from 'react';
import {
  MAX_SPEAK_CHARS,
  type AssistantContext,
  type TranscriptEntry,
} from '../../../shared/assistant';
import { languageByCode } from '../../../shared/languages';
import { useT } from '../../../shared/i18n/I18nProvider';
import { rt } from '../../ipc/client';
import type { TranscriptViewState } from '../../state/transcriptState';
import { isSpeaking, speakBlockReason } from './speakGate';

export function Composer({
  value,
  onChange,
  context,
  entries,
  lastError,
}: {
  value: string;
  onChange: (v: string) => void;
  context: AssistantContext;
  entries: TranscriptEntry[];
  lastError: TranscriptViewState['lastError'];
}): JSX.Element {
  const t = useT();
  const [translate, setTranslate] = useState(true);
  const [sending, setSending] = useState(false);
  const [lastSendAt, setLastSendAt] = useState(0);

  const sameLang = context.langs.user === context.langs.them;
  const block = speakBlockReason(context);
  const canSend = block === null && !sending && value.trim().length > 0;
  const speaking = isSpeaking(entries);
  const themLabel = languageByCode(context.langs.them)?.label ?? context.langs.them;
  // Only speak / LLM errors raised after the last send are shown here.
  const showError =
    lastError !== undefined &&
    (lastError.scope === 'speak' || lastError.scope === 'llm') &&
    lastError.at >= lastSendAt;

  const send = (): void => {
    if (!canSend) return;
    const text = value;
    setSending(true);
    setLastSendAt(Date.now());
    rt.speakText({ text, translate: sameLang ? false : translate })
      .then(() => onChange(''))
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[transcript] speakText failed', e);
      })
      .finally(() => setSending(false));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  return (
    <footer className="tr-composer">
      {block && <p className="tr-hint tr-hint--warn">{t(`transcript.composer.${block}`)}</p>}
      {showError && <p className="tr-error">{t(`assistant.errors.${lastError.code}`)}</p>}
      <textarea
        className="tr-composer__input"
        rows={2}
        value={value}
        maxLength={MAX_SPEAK_CHARS}
        placeholder={t('transcript.composer.placeholder')}
        onChange={(e): void => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="tr-composer__row">
        {!sameLang && (
          <label className="tr-composer__toggle">
            <input
              type="checkbox"
              checked={translate}
              onChange={(e): void => setTranslate(e.target.checked)}
            />
            {t('transcript.composer.translate', { lang: themLabel })}
          </label>
        )}
        <span className="tr-composer__count">
          {t('transcript.composer.charCount', { n: value.length, max: MAX_SPEAK_CHARS })}
        </span>
        {speaking && (
          <button
            type="button"
            className="btn btn-secondary tr-btn-sm"
            onClick={(): void => {
              rt.stopSpeaking().catch((e: unknown) => {
                // eslint-disable-next-line no-console
                console.warn('[transcript] stopSpeaking failed', e);
              });
            }}
          >
            {t('transcript.composer.stop')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary tr-btn-sm"
          disabled={!canSend}
          onClick={send}
        >
          {t('transcript.composer.send')}
        </button>
      </div>
    </footer>
  );
}
