import { useSyncExternalStore } from 'react';

/**
 * A tiny observable value. Used for app-wide settings and the demo dataset
 * so we don't need a state-management library.
 */
export interface Store<T> {
  // Arrow-function properties (not methods), so they can be passed around without `.bind()`.
  get: () => T;
  set: (next: T | ((previous: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value =
        typeof next === 'function' ? (next as (previous: T) => T)(value) : next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Read JSON from localStorage; returns the fallback if missing, blocked or invalid. */
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Write JSON to localStorage; returns false if storage is full or blocked. */
export function writeLocal(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing to remove.
  }
}
