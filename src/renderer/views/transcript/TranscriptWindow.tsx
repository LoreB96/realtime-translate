import { useCallback, useState, type JSX } from 'react';
import { useTranscriptSubscription } from '../../state/useTranscriptSubscription';
import { showSttCta } from '../../state/transcriptState';
import { TranscriptHeader } from './TranscriptHeader';
import { SttCta } from './SttCta';
import { TranscriptList } from './TranscriptList';
import { SuggestionsPanel } from './SuggestionsPanel';
import { Composer } from './Composer';
import { speakBlockReason } from './speakGate';

export function TranscriptWindow(): JSX.Element {
  const state = useTranscriptSubscription();
  const [draft, setDraft] = useState('');
  const onEdit = useCallback((text: string) => setDraft(text), []);
  const cta = showSttCta(state);
  const blocked = speakBlockReason(state.context);

  return (
    <div className="tr-root">
      <TranscriptHeader state={state} />
      {cta && <SttCta context={state.context} />}
      <TranscriptList entries={state.entries} speakBlocked={blocked !== null} />
      {state.prefs.suggestionsEnabled && (
        <SuggestionsPanel
          suggestions={state.suggestions}
          showNeedsStt={cta}
          speakBlocked={blocked !== null}
          onEdit={onEdit}
        />
      )}
      <Composer
        value={draft}
        onChange={setDraft}
        context={state.context}
        entries={state.entries}
        lastError={state.lastError}
      />
    </div>
  );
}
