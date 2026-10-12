import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { useT } from '../../../../shared/i18n/I18nProvider';
import {
  LLM_PRESET_IDS,
  LLM_PRESETS,
  MAX_LLM_KEY_CHARS,
  MAX_MODEL_CHARS,
  REASONING_EFFORTS,
  STT_ENGINES,
  STT_OPENAI_MODELS,
  MALE_TRANSLATE_VOICES,
  MALE_TTS_VOICES,
  isLoopbackHost,
  isOpenAiHost,
  isReasoningEffort,
  isValidBaseUrl,
  resolveAssistantPrefs,
  type AssistantErrorCode,
  type AssistantPrefs,
  type AssistantPrefsPatch,
  type LlmPreset,
  type SttStatus,
} from '../../../../shared/assistant';
import { rt } from '../../../ipc/client';

type TestRun =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; ms: number }
  | { kind: 'error'; code: AssistantErrorCode };

type ModelsRun =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; models: string[] }
  | { kind: 'empty' }
  | { kind: 'failed' };

const MODELS_DATALIST_ID = 'assist-llm-models';

function logError(what: string, e: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[assistant] ${what} failed`, e);
}

/** Options of a <select>: the known values plus the current one when it is not among them. */
function withCurrent(values: readonly string[], current: string): string[] {
  return values.includes(current) ? [...values] : [current, ...values];
}

interface AssistantPrefsApi {
  prefs: AssistantPrefs | null;
  save: (patch: AssistantPrefsPatch) => Promise<void>;
  /** Resolves once every save started so far has finished. */
  settled: () => Promise<unknown>;
  saveFailed: boolean;
  mounted: MutableRefObject<boolean>;
}

/**
 * Assistant prefs for one Settings section: loaded on mount, kept in step with pushes from
 * main (the bar and the transcript window change them too). Every change saves immediately.
 */
function useAssistantPrefs(): AssistantPrefsApi {
  const [prefs, setPrefs] = useState<AssistantPrefs | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const mounted = useRef(true);
  /** Chain of pending saves: list/test wait for it so they use what was just typed. */
  const pendingSave = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    mounted.current = true;
    // Subscribe first, then fetch: a push that arrives while fetching wins.
    let gotPush = false;
    const off = rt.onAssistantPrefs((p) => {
      gotPush = true;
      setPrefs(p);
    });
    rt.loadPrefs()
      .then((p) => {
        if (mounted.current && !gotPush) setPrefs(resolveAssistantPrefs(p.assistant));
      })
      .catch((e: unknown) => {
        logError('loadPrefs', e);
        if (mounted.current && !gotPush) setPrefs(resolveAssistantPrefs(undefined));
      });
    return (): void => {
      mounted.current = false;
      off();
    };
  }, []);

  const save = useCallback((patch: AssistantPrefsPatch): Promise<void> => {
    const run = pendingSave.current.then(async () => {
      try {
        const next = await rt.setAssistantPrefs(patch);
        if (!mounted.current) return;
        setPrefs(next);
        setSaveFailed(false);
      } catch (e) {
        logError('setAssistantPrefs', e);
        if (mounted.current) setSaveFailed(true);
      }
    });
    pendingSave.current = run;
    return run;
  }, []);

  const settled = useCallback(() => pendingSave.current, []);
  return { prefs, save, settled, saveFailed, mounted };
}

function SaveFailed({ show }: { show: boolean }): JSX.Element | null {
  const t = useT();
  if (!show) return null;
  return (
    <div className="trouble-banner trouble-banner--error" role="alert">
      {t('assistant.errors.unknown')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export function TranscriptionSection(): JSX.Element | null {
  const t = useT();
  const { prefs, save, saveFailed, mounted } = useAssistantPrefs();
  const [stt, setStt] = useState<SttStatus | null>(null);

  useEffect(() => {
    let gotPush = false;
    const off = rt.onSttStatus((s) => {
      gotPush = true;
      setStt(s);
    });
    rt.getSttStatus()
      .then((s) => {
        if (mounted.current && !gotPush) setStt(s);
      })
      .catch((e: unknown) => logError('getSttStatus', e));
    return off;
  }, [mounted]);

  if (!prefs) return null;
  const sttState = stt?.state ?? 'off';
  const sttError = stt?.state === 'error' ? stt.errorCode : undefined;

  return (
    <>
      <SaveFailed show={saveFailed} />
      <section className="trouble-section">
        <fieldset className="assist-fieldset">
          <legend className="setup-field-label">{t('assistant.stt.engine')}</legend>
          <div className="assist-radios" role="radiogroup">
            {STT_ENGINES.map((engine) => (
              <label key={engine} className="assist-radio">
                <input
                  type="radio"
                  name="assist-stt-engine"
                  value={engine}
                  checked={prefs.sttEngine === engine}
                  onChange={(): void => {
                    void save({ sttEngine: engine });
                  }}
                />
                <span>{t(`assistant.stt.${engine}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {prefs.sttEngine === 'openai' && (
          <div className="assist-field">
            <label className="setup-field-label" htmlFor="assist-stt-model">
              {t('assistant.stt.openaiModel')}
            </label>
            <select
              id="assist-stt-model"
              className="setup-input assist-select"
              value={prefs.sttOpenAiModel}
              onChange={(e): void => {
                void save({ sttOpenAiModel: e.target.value });
              }}
            >
              {withCurrent(STT_OPENAI_MODELS, prefs.sttOpenAiModel).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <div className="setup-field-hint">{t('assistant.stt.costOpenai')}</div>
          </div>
        )}

        <div className="assist-status" role="status">
          <span className={`assist-dot assist-dot--${sttState}`} aria-hidden="true" />
          <span>{t(`assistant.stt.state.${sttState}`)}</span>
          {sttError && (
            <span className="assist-status__error">{t(`assistant.errors.${sttError}`)}</span>
          )}
          {sttState === 'error' && (
            <button
              type="button"
              className="btn btn-secondary assist-btn-sm"
              onClick={(): void => {
                rt.retryStt().catch((e: unknown) => logError('retryStt', e));
              }}
            >
              {t('assistant.stt.retry')}
            </button>
          )}
        </div>
      </section>

      <section className="trouble-section">
        <Check
          checked={prefs.translateInputTranscript}
          onChange={(v): void => {
            void save({ translateInputTranscript: v });
          }}
          label={t('assistant.stt.inputTranscript')}
          hint={t('assistant.stt.inputTranscriptHint')}
        />
        <Check
          checked={prefs.translateTheirSpeech}
          onChange={(v): void => {
            void save({ translateTheirSpeech: v });
          }}
          label={t('assistant.stt.theirSpeech')}
          hint={t('assistant.stt.theirSpeechHint')}
        />
        <Check
          checked={prefs.transcriptOpenOnLaunch}
          onChange={(v): void => {
            void save({ transcriptOpenOnLaunch: v });
          }}
          label={t('assistant.stt.openOnLaunch')}
        />
        <div className="trouble-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={(): void => {
              rt.openTranscriptView().catch((e: unknown) => logError('openTranscriptView', e));
            }}
          >
            {t('assistant.stt.openNow')}
          </button>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// AI model
// ---------------------------------------------------------------------------

export function AiModelSection(): JSX.Element | null {
  const t = useT();
  const { prefs, save, settled, saveFailed, mounted } = useAssistantPrefs();
  const [keyHint, setKeyHint] = useState<string | undefined>();
  const [keyFailed, setKeyFailed] = useState(false);
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [models, setModels] = useState<ModelsRun>({ kind: 'idle' });
  const [test, setTest] = useState<TestRun>({ kind: 'idle' });

  useEffect(() => {
    rt.getLlmKeyHint()
      .then((h) => {
        if (mounted.current) setKeyHint(h);
      })
      .catch((e: unknown) => logError('getLlmKeyHint', e));
  }, [mounted]);

  // Keep the text drafts in step with the saved values (preset switch, pushes from main).
  const savedBaseUrl = prefs?.llm.baseUrl ?? '';
  const savedModel = prefs?.llm.model ?? '';
  useEffect(() => setBaseUrlDraft(savedBaseUrl), [savedBaseUrl]);
  useEffect(() => setModelDraft(savedModel), [savedModel]);

  if (!prefs) return null;

  const { llm } = prefs;
  const usesOpenAiKey = isOpenAiHost(llm.baseUrl);
  const draftUrl = baseUrlDraft.trim();
  const draftUrlValid = draftUrl === '' || isValidBaseUrl(draftUrl);
  const shownUrl = draftUrlValid && draftUrl !== '' ? draftUrl : llm.baseUrl;
  const insecure =
    shownUrl.startsWith('http:') && isValidBaseUrl(shownUrl) && !isLoopbackHost(shownUrl);

  const choosePreset = (preset: LlmPreset): void => {
    if (preset === llm.preset) return;
    setModels({ kind: 'idle' });
    setTest({ kind: 'idle' });
    // 'custom' keeps the current URL/model; the others fill them from the preset.
    void save(
      preset === 'custom' ? { llm: { preset } } : { llm: { preset, ...LLM_PRESETS[preset] } },
    );
  };

  const commitBaseUrl = (): void => {
    const v = baseUrlDraft.trim();
    if (v === llm.baseUrl || !isValidBaseUrl(v)) return;
    setModels({ kind: 'idle' });
    setTest({ kind: 'idle' });
    void save({ llm: { baseUrl: v } });
  };

  const commitModel = (): void => {
    const v = modelDraft.trim();
    if (v === llm.model || v.length > MAX_MODEL_CHARS) return;
    setTest({ kind: 'idle' });
    void save({ llm: { model: v } });
  };

  const loadModels = async (): Promise<void> => {
    setModels({ kind: 'running' });
    await settled();
    try {
      const r = await rt.listLlmModels();
      if (!mounted.current) return;
      if (!r.ok) setModels({ kind: 'failed' });
      else setModels(r.models.length > 0 ? { kind: 'done', models: r.models } : { kind: 'empty' });
    } catch (e) {
      logError('listLlmModels', e);
      if (mounted.current) setModels({ kind: 'failed' });
    }
  };

  const runTest = async (): Promise<void> => {
    setTest({ kind: 'running' });
    await settled();
    try {
      const r = await rt.testLlm();
      if (!mounted.current) return;
      setTest(r.ok ? { kind: 'ok', ms: r.ms } : { kind: 'error', code: r.code });
    } catch (e) {
      logError('testLlm', e);
      if (mounted.current) setTest({ kind: 'error', code: 'unknown' });
    }
  };

  const saveKey = async (): Promise<void> => {
    const v = keyDraft.trim();
    if (v.length < 1 || v.length > MAX_LLM_KEY_CHARS) return;
    try {
      await rt.setLlmKey(v);
      const hint = await rt.getLlmKeyHint();
      if (!mounted.current) return;
      setKeyDraft('');
      setKeyHint(hint);
      setKeyFailed(false);
      setTest({ kind: 'idle' });
    } catch (e) {
      logError('setLlmKey', e);
      if (mounted.current) setKeyFailed(true);
    }
  };

  const clearKey = async (): Promise<void> => {
    try {
      await rt.clearLlmKey();
      if (!mounted.current) return;
      setKeyHint(undefined);
      setTest({ kind: 'idle' });
    } catch (e) {
      logError('clearLlmKey', e);
      if (mounted.current) setKeyFailed(true);
    }
  };

  const showOllamaHint =
    llm.preset === 'ollama' &&
    test.kind === 'error' &&
    (test.code === 'llm-unreachable' || test.code === 'llm-model-missing');

  return (
    <>
      <SaveFailed show={saveFailed || keyFailed} />
      <section className="trouble-section">
        <div className="assist-field">
          <span className="setup-field-label" id="assist-preset-label">
            {t('assistant.llm.preset')}
          </span>
          <div className="assist-segmented" role="group" aria-labelledby="assist-preset-label">
            {LLM_PRESET_IDS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`assist-segmented__btn${llm.preset === preset ? ' active' : ''}`}
                aria-pressed={llm.preset === preset}
                onClick={(): void => choosePreset(preset)}
              >
                {t(`assistant.llm.${preset}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="assist-field">
          <label className="setup-field-label" htmlFor="assist-model">
            {t('assistant.llm.model')}
          </label>
          <div className="assist-row">
            <input
              id="assist-model"
              className="setup-input"
              type="text"
              spellCheck={false}
              maxLength={MAX_MODEL_CHARS}
              list={MODELS_DATALIST_ID}
              value={modelDraft}
              onChange={(e): void => setModelDraft(e.target.value)}
              onBlur={commitModel}
              onKeyDown={(e): void => {
                if (e.key === 'Enter') commitModel();
              }}
            />
            <button
              type="button"
              className="btn btn-secondary assist-btn-nowrap"
              disabled={models.kind === 'running'}
              onClick={(): void => {
                void loadModels();
              }}
            >
              {t('assistant.llm.loadModels')}
            </button>
          </div>
          <datalist id={MODELS_DATALIST_ID}>
            {models.kind === 'done' && models.models.map((m) => <option key={m} value={m} />)}
          </datalist>
          {models.kind === 'empty' && (
            <div className="setup-field-hint">{t('assistant.llm.modelsEmpty')}</div>
          )}
          {models.kind === 'failed' && (
            <div className="assist-inline-error">{t('assistant.llm.modelsFailed')}</div>
          )}
        </div>

        {usesOpenAiKey ? (
          <div className="setup-field-hint">{t('assistant.llm.openaiKeyUsed')}</div>
        ) : (
          <div className="assist-field">
            <label className="setup-field-label" htmlFor="assist-llm-key">
              {t('assistant.llm.apiKey')}
            </label>
            <div className="assist-row">
              <input
                id="assist-llm-key"
                className="setup-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_LLM_KEY_CHARS}
                value={keyDraft}
                onChange={(e): void => setKeyDraft(e.target.value)}
                onKeyDown={(e): void => {
                  if (e.key === 'Enter') void saveKey();
                }}
              />
              <button
                type="button"
                className="btn btn-secondary assist-btn-nowrap"
                disabled={keyDraft.trim().length === 0}
                onClick={(): void => {
                  void saveKey();
                }}
              >
                {t('assistant.llm.apiKeySave')}
              </button>
              {keyHint !== undefined && (
                <button
                  type="button"
                  className="btn btn-ghost assist-btn-nowrap"
                  onClick={(): void => {
                    void clearKey();
                  }}
                >
                  {t('assistant.llm.apiKeyClear')}
                </button>
              )}
            </div>
            {keyHint !== undefined && (
              <div className="setup-field-hint">
                {t('assistant.llm.apiKeySaved', { last4: keyHint })}
              </div>
            )}
            <div className="setup-field-hint">{t('assistant.llm.apiKeyHint')}</div>
          </div>
        )}

        <div className="trouble-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={test.kind === 'running'}
            onClick={(): void => {
              void runTest();
            }}
          >
            {t('assistant.llm.test')}
          </button>
          {test.kind === 'running' && (
            <span className="trouble-running" role="status">
              <span className="trouble-spinner" aria-hidden="true" />
            </span>
          )}
          {test.kind === 'ok' && (
            <span className="assist-inline-ok" role="status">
              ✓ {t('assistant.llm.testOk', { ms: test.ms })}
            </span>
          )}
          {test.kind === 'error' && (
            <span className="assist-inline-error" role="alert">
              {t(`assistant.errors.${test.code}`)}
            </span>
          )}
        </div>
        {showOllamaHint && (
          <div className="trouble-callout">
            {t('assistant.llm.hintOllama', { model: llm.model || LLM_PRESETS.ollama.model })}
          </div>
        )}
        <div className="setup-field-hint">{t('assistant.llm.cost')}</div>
      </section>

      {/* Server address and reasoning: rarely changed, so out of the way. */}
      <details className="trouble-details settings-advanced" open={llm.preset === 'custom'}>
        <summary>{t('assistant.llm.baseUrl')}</summary>
        <div className="assist-field">
          <input
            id="assist-base-url"
            aria-label={t('assistant.llm.baseUrl')}
            className={`setup-input${draftUrlValid ? '' : ' assist-input--invalid'}`}
            type="url"
            spellCheck={false}
            value={baseUrlDraft}
            aria-invalid={!draftUrlValid}
            onChange={(e): void => setBaseUrlDraft(e.target.value)}
            onBlur={commitBaseUrl}
            onKeyDown={(e): void => {
              if (e.key === 'Enter') commitBaseUrl();
            }}
          />
          {insecure && (
            <div className="trouble-banner trouble-banner--warning assist-inline-banner" role="alert">
              {t('assistant.llm.insecureWarn')}
            </div>
          )}
        </div>
        <div className="assist-field">
          <label className="setup-field-label" htmlFor="assist-reasoning">
            {t('assistant.llm.reasoning')}
          </label>
          <select
            id="assist-reasoning"
            className="setup-input assist-select"
            value={llm.reasoningEffort}
            onChange={(e): void => {
              const v = e.target.value;
              if (isReasoningEffort(v)) void save({ llm: { reasoningEffort: v } });
            }}
          >
            {REASONING_EFFORTS.map((r) => (
              <option key={r || 'default'} value={r}>
                {r === '' ? t('assistant.llm.reasoningDefault') : r}
              </option>
            ))}
          </select>
          <div className="setup-field-hint">{t('assistant.llm.reasoningHint')}</div>
        </div>
      </details>
    </>
  );
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export function VoiceSection(): JSX.Element | null {
  const t = useT();
  const { prefs, save, saveFailed } = useAssistantPrefs();
  if (!prefs) return null;
  const label = (v: string): string =>
    v === 'cedar' ? `${v} (${t('settings.voice.recommended')})` : v;
  return (
    <>
      <SaveFailed show={saveFailed} />
      <section className="trouble-section">
        <div className="assist-field">
          <label className="setup-field-label" htmlFor="assist-translate-voice">
            {t('settings.voice.translate')}
          </label>
          <select
            id="assist-translate-voice"
            className="setup-input assist-select"
            value={prefs.translateVoice}
            onChange={(e): void => {
              void save({ translateVoice: e.target.value });
            }}
          >
            {withCurrent(MALE_TRANSLATE_VOICES, prefs.translateVoice).map((v) => (
              <option key={v} value={v}>
                {label(v)}
              </option>
            ))}
          </select>
          <div className="setup-field-hint">{t('settings.voice.translateHint')}</div>
        </div>
        <div className="assist-field">
          <label className="setup-field-label" htmlFor="assist-voice">
            {t('settings.voice.typed')}
          </label>
          <select
            id="assist-voice"
            className="setup-input assist-select"
            value={prefs.ttsVoice}
            onChange={(e): void => {
              void save({ ttsVoice: e.target.value });
            }}
          >
            {withCurrent(MALE_TTS_VOICES, prefs.ttsVoice).map((v) => (
              <option key={v} value={v}>
                {label(v)}
              </option>
            ))}
          </select>
        </div>
        <Check
          checked={prefs.ttsMonitor}
          onChange={(v): void => {
            void save({ ttsMonitor: v });
          }}
          label={t('assistant.tts.monitor')}
        >
          <div className={`setup-field-hint${prefs.ttsMonitor ? ' assist-hint--warn' : ''}`}>
            {t('assistant.tts.monitorWarn')}
          </div>
        </Check>
        <div className="setup-field-hint">{t('assistant.tts.cost')}</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reply suggestions
// ---------------------------------------------------------------------------

export function SuggestionsSection(): JSX.Element | null {
  const t = useT();
  const { prefs, save, saveFailed } = useAssistantPrefs();
  if (!prefs) return null;
  return (
    <>
      <SaveFailed show={saveFailed} />
      <section className="trouble-section">
        <Check
          checked={prefs.suggestionsEnabled}
          onChange={(v): void => {
            void save({ suggestionsEnabled: v });
          }}
          label={t('assistant.suggest.enabled')}
        />
        <Check
          checked={prefs.autoSuggest}
          disabled={!prefs.suggestionsEnabled}
          onChange={(v): void => {
            void save({ autoSuggest: v });
          }}
          label={t('assistant.suggest.auto')}
        />
        <div className="setup-field-hint">{t('assistant.suggest.hint')}</div>
      </section>
    </>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <label className={`assist-check${disabled ? ' assist-check--disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled === true}
        onChange={(e): void => onChange(e.target.checked)}
      />
      <span className="assist-check__body">
        <span className="assist-check__label">{label}</span>
        {hint !== undefined && <span className="setup-field-hint assist-check__hint">{hint}</span>}
        {children}
      </span>
    </label>
  );
}
