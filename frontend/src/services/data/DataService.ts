import type {
  ConnectionStatus,
  ItemDetail,
} from '../../shared/types/domain.ts';
import type {
  DataSnapshot,
  LiveUpdate,
} from '../../../../app/contracts/dashboard.js';
export type {
  DataSnapshot,
  LiveUpdate,
} from '../../../../app/contracts/dashboard.js';

/**
 * Everything the UI needs from a data backend.
 *
 * Implementations:
 *   - MockDataService     (today: fictional demo data)
 *   - HttpDataService     (shared app backend and World Model)
 *   - CompositeDataService (real data, with demo data only when needed or asked for)
 *
 * Pick one in src/services/data/index.ts. Nothing else in the app imports an implementation.
 */

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
