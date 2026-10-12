import { useEffect } from 'react';
import { rt } from '../ipc/client';
import { useStore } from './store';

/**
 * Keeps `useStore().health` in sync with main: subscribes to pushes, then fetches the
 * current snapshot. A push is always newer than the initial fetch, so once one has
 * arrived the fetch result is dropped. Each renderer window has its own store, so every
 * window that shows health calls this once.
 */
export function useHealthSubscription(): void {
  useEffect(() => {
    const { setHealth } = useStore.getState();
    let alive = true;
    let pushed = false;
    const off = rt.onHealth((report) => {
      pushed = true;
      setHealth(report);
    });
    rt.getHealth()
      .then((report) => { if (alive && !pushed) setHealth(report); })
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[health] getHealth failed; waiting for health pushes', e);
      });
    return (): void => {
      alive = false;
      off();
    };
  }, []);
}
