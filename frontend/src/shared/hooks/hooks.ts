import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../lib/store.ts';

/** Current time, refreshed every `intervalMs` (for "5 min ago" labels and ranking). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/** useState that is remembered in localStorage (per browser). */
export function useLocalStorageState<T>(
  key: string,
  initial: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readLocal(key, initial));
  const update = useCallback(
    (next: T) => {
      setValue(next);
      writeLocal(key, next);
    },
    [key],
  );
  return [value, update];
}

/** useState that is remembered for this browser tab (survives going to a detail page and back). */
export function useSessionState<T>(
  key: string,
  initial: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage blocked: the value still works for this page view.
      }
    },
    [key],
  );
  return [value, update];
}
