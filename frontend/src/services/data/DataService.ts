import type {
  ConnectionStatus,
  HazeItem,
  ItemDetail,
  Location,
  Source,
} from '../../shared/types/domain.ts';

/**
 * Everything the UI needs from a data backend.
 *
 * Implementations:
 *   - MockDataService     (today: fictional demo data)
 *   - HttpDataService     (the HazeWatch server: real data from the World Model)
 *   - CompositeDataService (real data, with demo data only when needed or asked for)
 *
 * Pick one in src/services/data/index.ts. Nothing else in the app imports an implementation.
 */

export interface DataSnapshot {
  items: HazeItem[];
  locations: Location[];
  sources: Source[];
  /** When this snapshot was produced (ISO). */
  asOf: string;
  /** True if any data is fictional; the UI then shows the DEMO banner. */
  fictional: boolean;
}

export type LiveUpdate =
  /** New items, or new revisions of existing items (same id). */
  | { kind: 'upsert'; items: HazeItem[]; asOf: string }
  /** The whole dataset changed (e.g. regenerated): reload everything. */
  | { kind: 'reset'; snapshot: DataSnapshot };

export interface DataService {
  /** Shown in the UI, e.g. "Mock (demo data)". */
  readonly label: string;
  loadSnapshot(signal?: AbortSignal): Promise<DataSnapshot>;
  /** Full detail for one item, or null if it doesn't exist. */
  getItem(id: string, signal?: AbortSignal): Promise<ItemDetail | null>;
  /**
   * Receive live updates. Returns an unsubscribe function.
   * `onStatus` reports connection health for the header indicator.
   */
  subscribe(
    onUpdate: (update: LiveUpdate) => void,
    onStatus: (status: ConnectionStatus) => void,
  ): () => void;
}
