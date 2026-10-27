import { useSyncExternalStore } from 'react';

const storageKey = 'haze.manager.next-task-permissions.v1';
const listeners = new Set<() => void>();
type Setting = { version: 1; nightshift: boolean; permission_id?: string };
const disabled: Setting = { version: 1, nightshift: false };
let fallback: Setting = disabled;
let unsaved: Setting | undefined;
const permissionIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Only an explicit, versioned browser setting can enable the next task grant. */
function readSetting(): Setting {
  if (unsaved !== undefined) return unsaved;
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(storageKey);
  } catch {
    return fallback;
  }
  if (raw === null) return disabled;
  try {
    const saved: unknown = JSON.parse(raw);
    if (
      typeof saved === 'object' &&
      saved !== null &&
      'version' in saved &&
      saved.version === 1 &&
      'nightshift' in saved &&
      saved.nightshift === true &&
      'permission_id' in saved &&
      typeof saved.permission_id === 'string' &&
      permissionIdPattern.test(saved.permission_id)
    )
      return {
        version: 1,
        nightshift: true,
        permission_id: saved.permission_id,
      };
    return disabled;
  } catch {
    return disabled;
  }
}

export function getNextTaskNightshiftPermission(): boolean {
  return readSetting().nightshift;
}

/** A durable grant identity prevents reuse after an admission response is lost. */
export function getNextTaskNightshiftPermissionId(): string | undefined {
  return readSetting().permission_id;
}

export function setNextTaskNightshiftPermission(enabled: boolean): void {
  fallback = enabled
    ? {
        version: 1,
        nightshift: true,
        permission_id:
          getNextTaskNightshiftPermissionId() ?? crypto.randomUUID(),
      }
    : disabled;
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(fallback));
    unsaved = undefined;
  } catch {
    // The setting remains usable for this page when browser storage is blocked.
    unsaved = fallback;
  }
  listeners.forEach((listener) => listener());
}

/** Call after admission, never after a reply, clarification, or failed request. */
export function consumeNextTaskNightshiftPermission(token?: string): boolean {
  const setting = readSetting();
  if (
    !setting.nightshift ||
    (token !== undefined && token !== setting.permission_id)
  )
    return false;
  setNextTaskNightshiftPermission(false);
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNextTaskNightshiftPermission(): boolean {
  return useSyncExternalStore(
    subscribe,
    getNextTaskNightshiftPermission,
    getNextTaskNightshiftPermission,
  );
}
