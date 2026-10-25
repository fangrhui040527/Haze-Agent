import type {
  ConnectionStatus,
  ItemDetail,
} from '../../shared/types/domain.ts';
import type { DataService, DataSnapshot, LiveUpdate } from './DataService.ts';

/**
 * TODO(backend): real data adapter. NOT IMPLEMENTED — nothing here is confirmed.
 *
 * Important design rule: the BROWSER never talks to Zetaris directly. Zetaris credentials
 * must stay on the server (Spec §14.2 p.26: no secrets in browser assets). This adapter calls
 * OUR backend API; the backend queries Zetaris and returns data in a shape we agree on.
 *
 * Everything about Zetaris is UNKNOWN in the project files (docs/frontend/01-project-understanding.md §5.2). Before filling this in,
 * get answers to docs/frontend/02-critique.md §4:
 *   - Which backend endpoints exist (list, detail, live updates)? Paths and auth?
 *   - Response JSON shape? Map it to HazeItem/Location/Source in the TODO mappers below.
 *   - Live updates: SSE stream, WebSocket, or polling? How often?
 *   - Is any of it fictional/sample data? Set `fictional` accordingly.
 *
 * To switch the app to this adapter, edit ONE line in src/services/data/index.ts.
 */
export class ZetarisDataService implements DataService {
  readonly label = 'Backend API (Zetaris-backed)';
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  // TODO(backend): add the `signal?: AbortSignal` parameter and pass it to fetch() when implementing.
  loadSnapshot(): Promise<DataSnapshot> {
    // TODO(backend): e.g. const res = await fetch(`${this.baseUrl}/<agreed list endpoint>`, { signal });
    //                then map the JSON into DataSnapshot. Do not guess the endpoint.
    return Promise.reject(notImplemented(`loadSnapshot (${this.baseUrl})`));
  }

  // TODO(backend): signature becomes getItem(id: string, signal?: AbortSignal).
  getItem(): Promise<ItemDetail | null> {
    // TODO(backend): fetch one item's full detail; return null on 404.
    return Promise.reject(notImplemented('getItem'));
  }

  subscribe(
    _onUpdate: (update: LiveUpdate) => void,
    onStatus: (status: ConnectionStatus) => void,
  ): () => void {
    // TODO(backend): open an EventSource (SSE) or start polling; call onUpdate with
    //                { kind: 'upsert', items } for each change, and onStatus('live' | 'offline' | 'error').
    onStatus('error');
    return () => {};
  }
}

function notImplemented(what: string): Error {
  return new Error(
    `ZetarisDataService.${what} is not implemented yet. Switch back to the mock in src/services/data/index.ts, or implement the adapter (see the TODOs).`,
  );
}
