import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoStore, loadDemoDataset, resetToSeed } from './demoStore.ts';
import { generateDataset } from './generator/generate.ts';
import { validateDataset } from './generator/validate.ts';

const oldKey = 'hazewatch.demo.dataset.v1';
const newKey = 'haze.demo.dataset.v1';
const dataset = generateDataset({
  seed: 17,
  itemCount: 10,
  now: new Date('2026-10-24T00:00:00Z'),
});
const legacy = { ...dataset, schemaVersion: 'hazewatch.demo.v1' };
let stored: Map<string, string>;
let blocked = false;
beforeEach(() => {
  stored = new Map();
  blocked = false;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (blocked) throw new Error('full');
      stored.set(key, value);
    },
    removeItem: (key: string) => {
      stored.delete(key);
    },
  });
  vi.stubGlobal('fetch', vi.fn());
  demoStore.set({
    dataset: null,
    origin: 'none',
    version: 0,
    liveEvents: 0,
    saveWarning: null,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('renamed demo dataset compatibility', () => {
  it('accepts old exports, normalizes their schema and still validates their contents', () => {
    const result = validateDataset(legacy);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected a valid old export');
    expect(result.dataset).toEqual(dataset);
    expect(legacy.schemaVersion).toBe('hazewatch.demo.v1');
    expect(validateDataset({ ...legacy, fictional: false }).ok).toBe(false);
    expect(validateDataset({ ...legacy, schemaVersion: 'unknown' }).ok).toBe(
      false,
    );
  });

  it('restores old browser data and removes the old key after saving the new copy', async () => {
    stored.set(oldKey, JSON.stringify(legacy));
    const loaded = await loadDemoDataset();
    expect(loaded.schemaVersion).toBe('haze.demo.v1');
    expect(loaded.seed).toBe(17);
    expect(loaded.items.map((row) => row.id)).toEqual(
      dataset.items.map((row) => row.id),
    );
    expect(demoStore.get().origin).toBe('saved');
    const saved: unknown = JSON.parse(stored.get(newKey) ?? 'null');
    expect(saved).toMatchObject({ schemaVersion: 'haze.demo.v1' });
    expect(stored.has(oldKey)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the original saved data if migration cannot write the new key', async () => {
    stored.set(oldKey, JSON.stringify(legacy));
    blocked = true;
    expect((await loadDemoDataset()).seed).toBe(17);
    expect(stored.get(oldKey)).toBe(JSON.stringify(legacy));
    expect(stored.has(newKey)).toBe(false);
    expect(demoStore.get().saveWarning).toMatch(/Export/);
  });

  it('prefers a valid new save, and recovers the old save if the new one is invalid', async () => {
    stored.set(oldKey, JSON.stringify(legacy));
    stored.set(newKey, JSON.stringify({ ...dataset, seed: 99 }));
    expect((await loadDemoDataset()).seed).toBe(99);
    demoStore.set((state) => ({ ...state, dataset: null }));
    stored.set(newKey, JSON.stringify({ schemaVersion: 'broken' }));
    expect((await loadDemoDataset()).seed).toBe(17);
  });

  it('clears both saved keys only after loading a valid reset seed', async () => {
    stored.set(oldKey, JSON.stringify(legacy));
    stored.set(newKey, JSON.stringify(dataset));
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(resetToSeed()).rejects.toThrow('Could not load');
    expect(stored.has(oldKey)).toBe(true);
    expect(stored.has(newKey)).toBe(true);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(dataset));
    await resetToSeed();
    expect(stored.has(oldKey)).toBe(false);
    expect(stored.has(newKey)).toBe(false);
    expect(demoStore.get().origin).toBe('seed');
  });
});
