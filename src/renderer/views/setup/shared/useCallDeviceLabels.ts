import { useEffect, useState } from 'react';
import { rt } from '../../../ipc/client';
import { callDeviceLabels } from './cables';

/** Exact CABLE names for the call app's mic/speaker, from the live device inventory. */
export function useCallDeviceLabels(): { mic: string; speaker: string } {
  const [labels, setLabels] = useState(() => callDeviceLabels(undefined));
  useEffect(() => {
    let alive = true;
    rt.listDevices()
      .then((inv) => { if (alive) setLabels(callDeviceLabels(inv)); })
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[setup] listDevices failed, showing default cable names', e);
      });
    return (): void => { alive = false; };
  }, []);
  return labels;
}
