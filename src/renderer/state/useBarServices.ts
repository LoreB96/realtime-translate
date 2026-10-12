import { useCallback, useEffect, useState } from 'react';
import {
  resolveAssistantPrefs,
  type AssistantContext,
  type AssistantPrefs,
  type AssistantPrefsPatch,
  type SttStatus,
} from '../../shared/assistant';
import type { UsageSnapshot } from '../../shared/usage';
import { rt } from '../ipc/client';

export interface BarServices {
  prefs: AssistantPrefs | null;
  stt: SttStatus | null;
  context: AssistantContext | null;
  usage: UsageSnapshot | null;
  savePrefs: (patch: AssistantPrefsPatch) => void;
  resetUsage: () => void;
}

function logError(what: string, e: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[bar] ${what} failed`, e);
}

/**
 * What the bar needs to show and toggle the assistant services and their spend. Subscribes
 * first, then fetches: a push that arrives while fetching wins over the fetched snapshot.
 */
export function useBarServices(): BarServices {
  const [prefs, setPrefs] = useState<AssistantPrefs | null>(null);
  const [stt, setStt] = useState<SttStatus | null>(null);
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    const pushed = { prefs: false, stt: false, context: false, usage: false };
    const offs = [
      rt.onAssistantPrefs((p) => { pushed.prefs = true; setPrefs(p); }),
      rt.onSttStatus((s) => { pushed.stt = true; setStt(s); }),
      rt.onAssistantContext((c) => { pushed.context = true; setContext(c); }),
      rt.onUsage((u) => { pushed.usage = true; setUsage(u); }),
    ];
    rt.loadPrefs()
      .then((p) => { if (alive && !pushed.prefs) setPrefs(resolveAssistantPrefs(p.assistant)); })
      .catch((e: unknown) => logError('loadPrefs', e));
    rt.getSttStatus()
      .then((s) => { if (alive && !pushed.stt) setStt(s); })
      .catch((e: unknown) => logError('getSttStatus', e));
    rt.getAssistantContext()
      .then((c) => { if (alive && !pushed.context) setContext(c); })
      .catch((e: unknown) => logError('getAssistantContext', e));
    rt.getUsage()
      .then((u) => { if (alive && !pushed.usage) setUsage(u); })
      .catch((e: unknown) => logError('getUsage', e));
    return (): void => {
      alive = false;
      for (const off of offs) off();
    };
  }, []);

  const savePrefs = useCallback((patch: AssistantPrefsPatch): void => {
    rt.setAssistantPrefs(patch)
      .then(setPrefs)
      .catch((e: unknown) => logError('setAssistantPrefs', e));
  }, []);

  const resetUsage = useCallback((): void => {
    rt.resetUsage()
      .then(setUsage)
      .catch((e: unknown) => logError('resetUsage', e));
  }, []);

  return { prefs, stt, context, usage, savePrefs, resetUsage };
}
