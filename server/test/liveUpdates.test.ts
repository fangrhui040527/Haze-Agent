import { expect, it } from 'vitest';
import type { HazeItem } from '../../frontend/src/shared/types/domain.ts';
import { createLiveUpdateTracker } from '../src/world/liveUpdates.ts';

const row = (id: string, revision = 1) => ({ id, revision }) as HazeItem;
const snapshot = (items: HazeItem[]) => ({ items, locations: [], sources: [] });

it('replaces the table when any projected row disappears, even when the last row is removed', () => {
  const track = createLiveUpdateTracker(
    snapshot([row('hz-hotspot'), row('hz-reading')]),
  );
  const change = track(snapshot([row('hz-reading')]));
  expect(change?.kind).toBe('reset');
  if (change?.kind !== 'reset')
    throw new Error('Expected a replacement snapshot');
  expect(change.snapshot.items).toEqual([row('hz-reading')]);
  const empty = track(snapshot([]));
  expect(empty?.kind === 'reset' && empty.snapshot.items).toEqual([]);
});

it('sends only changed rows and recognizes a removed item if it later reappears unchanged', () => {
  const track = createLiveUpdateTracker(
    snapshot([row('hz-hotspot'), row('hz-reading')]),
  );
  expect(track(snapshot([row('hz-hotspot'), row('hz-reading')]))).toBeNull();
  const changed = track(snapshot([row('hz-hotspot'), row('hz-reading', 2)]));
  expect(changed?.kind === 'upsert' && changed.items).toEqual([
    row('hz-reading', 2),
  ]);
  track(snapshot([row('hz-reading', 2)]));
  const reappeared = track(snapshot([row('hz-hotspot'), row('hz-reading', 2)]));
  expect(reappeared?.kind === 'upsert' && reappeared.items).toEqual([
    row('hz-hotspot'),
  ]);
});

it('publishes content changes even if a revision number did not change', () => {
  const track = createLiveUpdateTracker(snapshot([row('hz-reading')]));
  const changed = {
    ...row('hz-reading'),
    summary: 'Updated supporting evidence',
  };
  const update = track(snapshot([changed]));
  expect(update?.kind === 'upsert' && update.items).toEqual([changed]);
});
