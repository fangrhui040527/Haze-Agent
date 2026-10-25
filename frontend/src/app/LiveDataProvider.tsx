import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { dataService, type LiveUpdate } from '../services/data/index.ts';
import { useLocalStorageState } from '../shared/hooks/hooks.ts';
import { isAbortError } from '../shared/lib/delay.ts';
import type { ConnectionStatus, HazeItem } from '../shared/types/domain.ts';
import { LiveDataContext, type LiveDataState } from './liveDataContext.ts';

/** Put changed items first and drop their older copies. */
function merge(current: HazeItem[], changed: HazeItem[]): HazeItem[] {
  const ids = new Set(changed.map((i) => i.id));
  return [...changed, ...current.filter((i) => !ids.has(i.id))];
}

type DataPart = Pick<
  LiveDataState,
  | 'status'
  | 'error'
  | 'items'
  | 'locations'
  | 'sources'
  | 'fictional'
  | 'lastUpdatedAt'
>;

const INITIAL: DataPart = {
  status: 'loading',
  error: null,
  items: [],
  locations: [],
  sources: [],
  fictional: true,
  lastUpdatedAt: null,
};

/** Loads data once for the whole app and keeps it live. */
export function LiveDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<DataPart>(INITIAL);
  const [pending, setPending] = useState<HazeItem[]>([]);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [autoApply, setAutoApply] = useLocalStorageState(
    'haze.table.autoApply',
    false,
  );
  const [attempt, setAttempt] = useState(0);
  const autoApplyRef = useRef(autoApply);
  useEffect(() => {
    autoApplyRef.current = autoApply;
  }, [autoApply]);

  const flash = useCallback((ids: string[]) => {
    setFreshIds(new Set(ids));
  }, []);

  useEffect(() => {
    if (freshIds.size === 0) return;
    const timer = setTimeout(() => setFreshIds(new Set()), 4000);
    return () => clearTimeout(timer);
  }, [freshIds]);

  useEffect(() => {
    const controller = new AbortController();
    let unsubscribe: (() => void) | null = null;
    setData((d) => ({ ...d, status: 'loading', error: null }));
    setConnection('connecting');

    dataService
      .loadSnapshot(controller.signal)
      .then((snapshot) => {
        setData({
          status: 'ready',
          error: null,
          items: snapshot.items,
          locations: snapshot.locations,
          sources: snapshot.sources,
          fictional: snapshot.fictional,
          lastUpdatedAt: snapshot.asOf,
        });
        setPending([]);
        unsubscribe = dataService.subscribe((update: LiveUpdate) => {
          if (update.kind === 'reset') {
            const s = update.snapshot;
            setData({
              status: 'ready',
              error: null,
              items: s.items,
              locations: s.locations,
              sources: s.sources,
              fictional: s.fictional,
              lastUpdatedAt: s.asOf,
            });
            setPending([]);
            return;
          }
          if (autoApplyRef.current) {
            setData((d) => ({
              ...d,
              items: merge(d.items, update.items),
              lastUpdatedAt: update.asOf,
            }));
            flash(update.items.map((i) => i.id));
          } else {
            setPending((p) => merge(p, update.items));
            setData((d) => ({ ...d, lastUpdatedAt: update.asOf }));
          }
        }, setConnection);
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setConnection('error');
        setData((d) => ({
          ...d,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }));
      });

    return () => {
      controller.abort();
      unsubscribe?.();
    };
  }, [attempt, flash]);

  const applyPending = useCallback(() => {
    if (pending.length === 0) return;
    setData((d) => ({ ...d, items: merge(d.items, pending) }));
    flash(pending.map((i) => i.id));
    setPending([]);
  }, [pending, flash]);

  const value = useMemo(
    () => ({
      ...data,
      pending,
      freshIds,
      connection,
      autoApply,
      dataSourceLabel: dataService.label,
      retry: () => setAttempt((n) => n + 1),
      applyPending,
      setAutoApply,
    }),
    [
      data,
      pending,
      freshIds,
      connection,
      autoApply,
      applyPending,
      setAutoApply,
    ],
  );

  return (
    <LiveDataContext.Provider value={value}>
      {children}
    </LiveDataContext.Provider>
  );
}
