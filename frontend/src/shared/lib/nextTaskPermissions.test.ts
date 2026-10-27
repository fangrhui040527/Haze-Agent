import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeNextTaskNightshiftPermission,
  getNextTaskNightshiftPermission,
  getNextTaskNightshiftPermissionId,
  setNextTaskNightshiftPermission,
} from './nextTaskPermissions.ts';

describe('next task permissions', () => {
  let saved: Map<string, string>;
  beforeEach(() => {
    saved = new Map();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    });
    setNextTaskNightshiftPermission(false);
    saved.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to off and rejects unversioned or malformed grants', () => {
    expect(getNextTaskNightshiftPermission()).toBe(false);
    setNextTaskNightshiftPermission(true);
    const key = [...saved.keys()][0];
    for (const value of [
      'true',
      '{}',
      '{',
      '{"version":2,"nightshift":true}',
    ]) {
      saved.set(key, value);
      expect(getNextTaskNightshiftPermission()).toBe(false);
    }
  });

  it('retains the setting through reads, then consumes it for one admission', () => {
    setNextTaskNightshiftPermission(true);
    expect(getNextTaskNightshiftPermission()).toBe(true);
    expect(getNextTaskNightshiftPermission()).toBe(true);
    expect(consumeNextTaskNightshiftPermission()).toBe(true);
    expect(getNextTaskNightshiftPermission()).toBe(false);
    expect(consumeNextTaskNightshiftPermission()).toBe(false);
    expect([...saved.values()][0]).toBe('{"version":1,"nightshift":false}');
  });

  it('does not enable a grant for truthy strings', () => {
    setNextTaskNightshiftPermission(true);
    const key = [...saved.keys()][0];
    saved.set(key, '{"version":1,"nightshift":"true"}');
    expect(getNextTaskNightshiftPermission()).toBe(false);
  });

  it('keeps one grant identity across replies, reads, and repeated enablement', () => {
    setNextTaskNightshiftPermission(true);
    const token = getNextTaskNightshiftPermissionId();
    expect(token).toMatch(/^[0-9a-f-]{36}$/i);
    setNextTaskNightshiftPermission(true);
    expect(getNextTaskNightshiftPermissionId()).toBe(token);
    expect(consumeNextTaskNightshiftPermission(token)).toBe(true);
    expect(getNextTaskNightshiftPermissionId()).toBeUndefined();
  });

  it('does not clear a new grant when an earlier admission arrives late', () => {
    setNextTaskNightshiftPermission(true);
    const previous = getNextTaskNightshiftPermissionId();
    setNextTaskNightshiftPermission(false);
    setNextTaskNightshiftPermission(true);
    const current = getNextTaskNightshiftPermissionId();
    expect(current).not.toBe(previous);
    expect(consumeNextTaskNightshiftPermission(previous)).toBe(false);
    expect(getNextTaskNightshiftPermissionId()).toBe(current);
    expect(consumeNextTaskNightshiftPermission(current)).toBe(true);
  });

  it('keeps one-use behavior when browser storage is blocked or full', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('Quota exceeded');
      },
    });
    setNextTaskNightshiftPermission(true);
    expect(getNextTaskNightshiftPermission()).toBe(true);
    expect(consumeNextTaskNightshiftPermission()).toBe(true);
    expect(getNextTaskNightshiftPermission()).toBe(false);
  });
});
