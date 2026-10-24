import { createContext, useContext } from 'react';
import type {
  ConnectionStatus,
  HazeItem,
  Location,
  Source,
} from '../shared/types/domain.ts';

export interface LiveDataState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  items: HazeItem[];
  locations: Location[];
  sources: Source[];
  fictional: boolean;
  connection: ConnectionStatus;
  /** When data last arrived (load or live update). */
  lastUpdatedAt: string | null;
  /** Live updates waiting for the user to click "show" (rows never jump on their own). */
  pending: HazeItem[];
  /** Ids applied in the most recent update, for a short highlight. */
  freshIds: ReadonlySet<string>;
  autoApply: boolean;
  dataSourceLabel: string;
}

export interface LiveDataActions {
  retry(): void;
  applyPending(): void;
  setAutoApply(value: boolean): void;
}

export const LiveDataContext = createContext<
  (LiveDataState & LiveDataActions) | null
>(null);

export function useLiveData(): LiveDataState & LiveDataActions {
  const value = useContext(LiveDataContext);
  if (!value)
    throw new Error('useLiveData() must be used inside <LiveDataProvider>.');
  return value;
}
