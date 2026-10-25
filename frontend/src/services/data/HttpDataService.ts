import type {
  ConnectionStatus,
  ItemDetail,
} from '../../shared/types/domain.ts';
import type { DataService, DataSnapshot, LiveUpdate } from './DataService.ts';

/**
 * Real data from the Haze server (server/), which reads the Meterless World Model
 * fed by HazeOps. The browser never talks to Zetaris, OpenAQ, FIRMS or the engines
 * directly; keys stay on the server.
 *
 *   GET /api/snapshot     -> DataSnapshot
 *   GET /api/items/:id    -> ItemDetail (404 -> null)
 *   GET /api/stream (SSE) -> "upsert" events carrying LiveUpdate
 */
export class HttpDataService implements DataService {
  readonly label = 'Haze server (real data)';
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
    source.addEventListener('upsert', (event) => {
      onUpdate(JSON.parse((event as MessageEvent<string>).data) as LiveUpdate);
    });
    source.onerror = () => {
      onStatus(source.readyState === EventSource.CLOSED ? 'error' : 'offline');
    };
    return () => source.close();
  }
}
