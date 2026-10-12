import { useEffect, useReducer } from 'react';
import { DEFAULT_ASSISTANT_PREFS, resolveAssistantPrefs } from '../../shared/assistant';
import { rt } from '../ipc/client';
import {
  initialTranscriptState,
  transcriptReducer,
  type TranscriptAction,
  type TranscriptViewState,
} from './transcriptState';

function warn(what: string, e: unknown): void {
  // Error objects only: these calls never carry transcript text.
  // eslint-disable-next-line no-console
  console.warn(`[transcript] ${what} failed; waiting for pushes`, e);
}

/**
 * Keeps the transcript window state in sync with main: subscribes to every push first,
 * then fetches the snapshots. A push that arrived during the fetch wins (it is newer):
 * entries merge by `updatedAt`, the other slices drop the fetched value once pushed.
 */
export function useTranscriptSubscription(): TranscriptViewState {
  const [state, dispatch] = useReducer(
    transcriptReducer,
    DEFAULT_ASSISTANT_PREFS,
    initialTranscriptState,
  );

  useEffect(() => {
    let alive = true;
    const pushed = { suggestions: false, stt: false, prefs: false, context: false };
    const send = (a: TranscriptAction): void => {
      if (alive) dispatch(a);
    };

    const offs = [
      rt.onTranscriptEntry((entry) => send({ type: 'upsert', entry })),
      rt.onTranscriptCleared(() => send({ type: 'cleared' })),
      rt.onSuggestions((s) => {
        pushed.suggestions = true;
        send({ type: 'suggestions', s });
      }),
      rt.onSttStatus((s) => {
        pushed.stt = true;
        send({ type: 'stt', s });
      }),
      rt.onAssistantError((e) =>
        send({ type: 'error', scope: e.scope, code: e.code, at: Date.now() }),
      ),
      rt.onAssistantPrefs((p) => {
        pushed.prefs = true;
        send({ type: 'prefs', p });
      }),
      rt.onAssistantContext((c) => {
        pushed.context = true;
        send({ type: 'context', c });
      }),
    ];

    rt.getTranscript()
      .then((entries) => send({ type: 'snapshot', entries }))
      .catch((e: unknown) => warn('getTranscript', e));
    rt.getSuggestions()
      .then((s) => {
        if (!pushed.suggestions) send({ type: 'suggestions', s });
      })
      .catch((e: unknown) => warn('getSuggestions', e));
    rt.getSttStatus()
      .then((s) => {
        if (!pushed.stt) send({ type: 'stt', s });
      })
      .catch((e: unknown) => warn('getSttStatus', e));
    rt.getAssistantContext()
      .then((c) => {
        if (!pushed.context) send({ type: 'context', c });
      })
      .catch((e: unknown) => warn('getAssistantContext', e));
    rt.loadPrefs()
      .then((prefs) => {
        if (!pushed.prefs) send({ type: 'prefs', p: resolveAssistantPrefs(prefs.assistant) });
      })
      .catch((e: unknown) => warn('loadPrefs', e));

    return (): void => {
      alive = false;
      for (const off of offs) off();
    };
  }, []);

  return state;
}
