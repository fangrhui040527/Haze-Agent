import type { DataSnapshot, LiveUpdate } from '../contracts/dashboard.js';

type Snapshot = Pick<DataSnapshot, 'items' | 'locations' | 'sources'> &
  Partial<Pick<DataSnapshot, 'fictional'>>;

/** Track disappearing rows and metadata so clients keep one coherent view. */
export function createLiveUpdateTracker(
  initial: Snapshot,
  clock: () => Date = () => new Date(),
) {
  let previous = new Map(
    initial.items.map((item) => [item.id, JSON.stringify(item)]),
  );
  const metadata = (value: Snapshot) =>
    JSON.stringify([value.locations, value.sources, value.fictional ?? false]);
  let previousMetadata = metadata(initial);
  return (snapshot: Snapshot): LiveUpdate | null => {
    const current = new Map(
      snapshot.items.map((item) => [item.id, JSON.stringify(item)]),
    );
    const removed = [...previous.keys()].some((id) => !current.has(id));
    const changed = snapshot.items.filter(
      (item) => previous.get(item.id) !== current.get(item.id),
    );
    const currentMetadata = metadata(snapshot);
    const metadataChanged = currentMetadata !== previousMetadata;
    previous = current;
    previousMetadata = currentMetadata;
    const asOf = clock().toISOString();
    if (removed || metadataChanged) {
      return {
        kind: 'reset',
        snapshot: {
          ...snapshot,
          asOf,
          fictional: snapshot.fictional ?? false,
        },
      };
    }
    return changed.length ? { kind: 'upsert', items: changed, asOf } : null;
  };
}
