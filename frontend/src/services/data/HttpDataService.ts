import type {
  ConnectionStatus,
  ItemDetail,
} from '../../shared/types/domain.ts';
import type { DataService, DataSnapshot, LiveUpdate } from './DataService.ts';

/**
 * Dashboard views from the shared app backend and authoritative SQLite World Model.
 * HazeOps watchers and agent tasks retain evidence in that same model. Source
 * credentials and retrieval stay in the backend.
 *
 *   GET /api/snapshot     -> DataSnapshot
 *   GET /api/items/:id    -> ItemDetail (404 -> null)
 *   GET /api/stream (SSE) -> "reset" / "upsert" events carrying LiveUpdate
 */
export class HttpDataService implements DataService {
  readonly label = 'Haze app (shared World Model)';
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async loadSnapshot(signal?: AbortSignal): Promise<DataSnapshot> {
    const response = await fetch(`${this.baseUrl}/api/snapshot`, { signal });
    if (!response.ok) {
      throw new Error(`Server returned ${response.status} for the snapshot.`);
    }
    return (await response.json()) as DataSnapshot;
  }

  async getItem(id: string, signal?: AbortSignal): Promise<ItemDetail | null> {
    const response = await fetch(
      `${this.baseUrl}/api/items/${encodeURIComponent(id)}`,
      { signal },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Server returned ${response.status} for item ${id}.`);
    }
    return (await response.json()) as ItemDetail;
  }

  subscribe(
    onUpdate: (update: LiveUpdate) => void,
    onStatus: (status: ConnectionStatus) => void,
  ): () => void {
    onStatus('connecting');
    // EventSource reconnects by itself after a dropped connection.
    const source = new EventSource(`${this.baseUrl}/api/stream`);
    source.addEventListener('hello', () => onStatus('live'));
    const receive = (event: Event) => {
      onUpdate(JSON.parse((event as MessageEvent<string>).data) as LiveUpdate);
    };
    // Every connection begins with a snapshot, including reconnects. This also
    // covers changes made between the initial HTTP load and subscribing.
    source.addEventListener('reset', receive);
    source.addEventListener('upsert', receive);
    source.onerror = () => {
      onStatus(source.readyState === EventSource.CLOSED ? 'error' : 'offline');
    };
    return () => source.close();
  }
}
