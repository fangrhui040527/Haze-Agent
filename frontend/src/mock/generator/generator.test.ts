import { describe, expect, it } from 'vitest';
import { generateDataset } from './generate.ts';
import { rebaseDataset } from './rebase.ts';
import { simulateEvents } from './simulate.ts';
import { validateDataset } from './validate.ts';

const NOW = new Date('2026-10-23T12:00:00Z');
const dataset = generateDataset({ seed: 42, itemCount: 200, now: NOW });

describe('generateDataset', () => {
  it('is deterministic for the same seed', () => {
    const again = generateDataset({ seed: 42, itemCount: 200, now: NOW });
    expect(JSON.stringify(again)).toBe(JSON.stringify(dataset));
  });

  it('produces a dataset that passes import validation and is labelled fictional', () => {
    const result = validateDataset(dataset);
    expect(result.ok).toBe(true);
    expect(dataset.fictional).toBe(true);
    expect(dataset.items.every((i) => i.fictional)).toBe(true);
  });

  it('gives every location at least two items and covers every category and status', () => {
    for (const location of dataset.locations) {
      expect(
        dataset.items.filter((i) => i.locationId === location.id).length,
      ).toBeGreaterThanOrEqual(2);
    }
    expect(new Set(dataset.items.map((i) => i.category)).size).toBe(9);
    expect(new Set(dataset.items.map((i) => i.status)).size).toBe(6);
  });

  it('includes the deliberate edge cases', () => {
    const tags = new Set(dataset.items.flatMap((i) => i.tags));
    for (const tag of [
      'missing-values',
      'zero-reading',
      'extreme-value',
      'long-text',
      'retracted',
      'conflicting',
      'no-checks',
      'missing-source',
      'stale',
      'non-ascii',
    ]) {
      expect(tags.has(tag), tag).toBe(true);
    }
  });

  it('keeps source times in order: measured/published <= retrieved <= updated', () => {
    for (const item of dataset.items) {
      for (const ref of item.sources) {
        const first = Date.parse(
          ref.measuredAt ?? ref.publishedAt ?? ref.retrievedAt,
        );
        expect(first).toBeLessThanOrEqual(Date.parse(ref.retrievedAt));
        expect(Date.parse(ref.retrievedAt)).toBeLessThanOrEqual(
          Date.parse(item.updatedAt),
        );
      }
    }
  });

  it('focuses on Malaysia first, then Indonesia', () => {
    const countryOf = new Map(
      dataset.locations.map((l) => [l.id, l.countryCode]),
    );
    const count = (code: string) =>
      dataset.items.filter((i) => countryOf.get(i.locationId) === code).length;
    expect(dataset.locations.every((l) => l.region === 'Southeast Asia')).toBe(
      true,
    );
    expect(count('MY')).toBeGreaterThan(count('ID'));
    expect(count('ID')).toBeGreaterThan(
      dataset.items.length - count('MY') - count('ID'),
    );
  });

  it('adds the other continents only with worldwide coverage', () => {
    const world = generateDataset({
      seed: 42,
      itemCount: 200,
      now: NOW,
      coverage: 'worldwide',
    });
    expect(new Set(world.locations.map((l) => l.region)).size).toBe(9);
    expect(validateDataset(world).ok).toBe(true);
  });

  it('only uses example.org links for sources (nothing looks like a real organisation)', () => {
    expect(
      dataset.sources.every((s) => s.url.startsWith('https://example.org/')),
    ).toBe(true);
  });
});

describe('validateDataset', () => {
  it('rejects a file with an unknown location and explains where', () => {
    const broken = structuredClone(dataset);
    broken.items[0].locationId = 'atlantis';
    const result = validateDataset(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('items[0].locationId');
  });

  it('rejects data that is not marked fictional', () => {
    expect(validateDataset({ ...dataset, fictional: false }).ok).toBe(false);
  });
});

describe('simulateEvents and rebaseDataset', () => {
  it('creates new items or revisions dated "now"', () => {
    const now = NOW.getTime() + 60_000;
    const changed = simulateEvents(dataset, {
      count: 10,
      scenario: 'spike',
      now,
      seed: 7,
    });
    expect(changed.length).toBeGreaterThan(0);
    for (const item of changed) {
      expect(Math.abs(Date.parse(item.updatedAt) - now)).toBeLessThan(2000);
      const previous = dataset.items.find((i) => i.id === item.id);
      if (previous) expect(item.revision).toBe(previous.revision + 1);
    }
  });

  it('shifts all times so the newest item is just before now, keeping gaps between items', () => {
    const later = NOW.getTime() + 7 * 86_400_000;
    const shifted = rebaseDataset(dataset, later);
    const newest = Math.max(
      ...shifted.items.map((i) => Date.parse(i.updatedAt)),
    );
    expect(later - newest).toBe(60_000);
    const gap = (d: typeof dataset) =>
      Date.parse(d.items[0].updatedAt) - Date.parse(d.items[5].updatedAt);
    expect(gap(shifted)).toBe(gap(dataset));
  });
});
