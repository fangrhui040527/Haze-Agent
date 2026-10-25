import type {
  DataSnapshot,
  LiveUpdate,
} from '../../../frontend/src/services/data/DataService.ts';

type Snapshot = Pick<DataSnapshot, 'items' | 'locations' | 'sources'>;

/** Track removals as well as revisions so a vanished hotspot leaves live tables. */
export function createLiveUpdateTracker(initial: Snapshot) {
  let previous = new Map(
    initial.items.map((item) => [item.id, JSON.stringify(item)]),
  );
  return (snapshot: Snapshot): LiveUpdate | null => {
    const current = new Map(
      snapshot.items.map((item) => [item.id, JSON.stringify(item)]),
    );
    const removed = [...previous.keys()].some((id) => !current.has(id));
    const changed = snapshot.items.filter(
      (item) => previous.get(item.id) !== current.get(item.id),
    );
    previous = current;
    const asOf = new Date().toISOString();
    if (removed) {
      return {
        kind: 'reset',
        snapshot: { ...snapshot, asOf, fictional: false },
      };
    }
    return changed.length ? { kind: 'upsert', items: changed, asOf } : null;
  };
}
