import { useEffect, useState } from 'react';
import {
  REFRESH_MS,
  fetchFires,
  fetchRegionSnapshot,
  readCachedSnapshot,
  writeCachedSnapshot,
  type FireResult,
  type RegionSnapshot,
} from './airQuality.ts';

export type RegionStatus = 'loading' | 'live' | 'cached' | 'error';

export interface RegionData {
  snapshot: RegionSnapshot | null;
  status: RegionStatus;
  error: string | null;
  fires: FireResult | null;
}

/**
 * Live regional readings. Refreshes every ~12 minutes while the tab is visible and
 * pauses while hidden. On failure the last good snapshot stays on screen (status "cached").
 */
export function useRegionData(): RegionData {
  const [state, setState] = useState<RegionData>(() => {
    const cached = readCachedSnapshot();
    return {
      snapshot: cached,
      status: cached ? 'cached' : 'loading',
      error: null,
      fires: null,
    };
  });

  useEffect(() => {
    let controller: AbortController | null = null;
    let timer: number | undefined;
    let lastLoad = 0;

    async function load() {
      controller?.abort();
      const ctrl = new AbortController();
      controller = ctrl;
      const [aq, fires] = await Promise.allSettled([
        fetchRegionSnapshot(ctrl.signal),
        fetchFires(ctrl.signal),
      ]);
      if (ctrl.signal.aborted) return;
      lastLoad = Date.now();
      setState((prev) => {
        const next = { ...prev };
        if (aq.status === 'fulfilled') {
          writeCachedSnapshot(aq.value);
          next.snapshot = aq.value;
          next.status = 'live';
          next.error = null;
        } else {
          next.status = prev.snapshot ? 'cached' : 'error';
          next.error =
            aq.reason instanceof Error ? aq.reason.message : String(aq.reason);
        }
        if (fires.status === 'fulfilled') next.fires = fires.value;
        return next;
      });
    }

    function schedule() {
      window.clearInterval(timer);
      if (document.visibilityState !== 'visible') {
        controller?.abort();
        return;
      }
      // Coming back to the tab only refetches if the last load is due.
      if (Date.now() - lastLoad >= REFRESH_MS) void load();
      timer = window.setInterval(() => void load(), REFRESH_MS);
    }

    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      document.removeEventListener('visibilitychange', schedule);
      window.clearInterval(timer);
      controller?.abort();
    };
  }, []);

  return state;
}
