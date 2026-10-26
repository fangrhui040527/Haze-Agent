import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import type {
  WorldBrowseResponse,
  WorldProjectionRebuildResponse,
} from '../../../../app/contracts/world-api.ts';
import { browseWorldRecords, rebuildWorldProjections } from './api.ts';
import { recordTitle, WorldModelRecord } from './WorldModelRecord.tsx';
import styles from './WorldModelPage.module.css';

type Panel = 'inspect' | 'rebuild' | 'reference';
const panels: { id: Panel; label: string; description: string }[] = [
  {
    id: 'inspect',
    label: 'Inspect',
    description: 'Records, relationships & history',
  },
  { id: 'rebuild', label: 'Rebuild', description: 'Restore derived views' },
  {
    id: 'reference',
    label: 'Reference sandbox',
    description: 'Original Meterless control plane',
  },
];

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'The World Model request failed.';

export function WorldModelPage() {
  const [params, setParams] = useSearchParams();
  const requestedPanel = params.get('panel');
  const panel: Panel =
    requestedPanel === 'reference' || requestedPanel === 'rebuild'
      ? requestedPanel
      : 'inspect';
  const kind = params.get('kind') ?? '';
  const query = params.get('q') ?? '';
  const [refresh, setRefresh] = useState(0);
  const [browse, setBrowse] = useState<{
    data: WorldBrowseResponse | null;
    loading: boolean;
    error: string | null;
    appending: boolean;
  }>({ data: null, loading: true, error: null, appending: false });
  const selectedId =
    params.get('record') ?? browse.data?.records[0]?.ref.id ?? null;
  const browseController = useRef<AbortController | null>(null);
  const rebuildController = useRef<AbortController | null>(null);
  const operationKey = useRef<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] =
    useState<WorldProjectionRebuildResponse | null>(null);
  const isReference = panel === 'reference';

  useEffect(() => {
    if (isReference) return;
    const controller = new AbortController();
    browseController.current = controller;
    setBrowse({ data: null, loading: true, error: null, appending: false });
    browseWorldRecords(
      {
        ...(kind ? { kind } : {}),
        ...(query ? { query } : {}),
        limit: 25,
      },
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setBrowse({ data, loading: false, error: null, appending: false });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setBrowse({
            data: null,
            loading: false,
            error: errorMessage(error),
            appending: false,
          });
      });
    return () => controller.abort();
  }, [kind, query, refresh, isReference]);

  useEffect(() => () => rebuildController.current?.abort(), []);

  function changePanel(nextPanel: Panel) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (nextPanel === 'inspect') next.delete('panel');
      else next.set('panel', nextPanel);
      return next;
    });
  }

  function selectRecord(recordId: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('record', recordId);
      next.delete('panel');
      return next;
    });
  }

  function filterRecords(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setParams((current) => {
      const next = new URLSearchParams(current);
      const text = String(fields.get('query') ?? '').trim();
      if (text) next.set('q', text);
      else next.delete('q');
      next.delete('record');
      return next;
    });
  }

  async function loadMore() {
    const cursor = browse.data?.next_cursor;
    const controller = browseController.current;
    if (!cursor || !controller || controller.signal.aborted || browse.appending)
      return;
    setBrowse((current) => ({ ...current, appending: true, error: null }));
    try {
      const data = await browseWorldRecords(
        {
          ...(kind ? { kind } : {}),
          ...(query ? { query } : {}),
          cursor,
          limit: 25,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setBrowse((current) => {
        const records = new Map(
          current.data?.records.map((record) => [record.ref.id, record]),
        );
        for (const record of data.records) records.set(record.ref.id, record);
        return {
          data: { ...data, records: [...records.values()] },
          loading: false,
          appending: false,
          error: null,
        };
      });
    } catch (error) {
      if (!controller.signal.aborted)
        setBrowse((current) => ({
          ...current,
          appending: false,
          error: errorMessage(error),
        }));
    }
  }

  async function rebuild() {
    if (rebuilding) return;
    const controller = new AbortController();
    rebuildController.current = controller;
    operationKey.current ??= crypto.randomUUID();
    setRebuilding(true);
    setRebuildError(null);
    setRebuildResult(null);
    try {
      const result = await rebuildWorldProjections(
        operationKey.current,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      operationKey.current = null;
      setRebuildResult(result);
      setRefresh((value) => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setRebuildError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setRebuilding(false);
    }
  }

  return (
    <article className={styles.controlPlane}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Haze / World Model</p>
          <h1>
            World Model <span>Control plane</span>
          </h1>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.mode}>
            <span className={styles.dot} />
            {isReference
              ? 'Reference sandbox'
              : browse.data
                ? browse.data.scope.mode + ' records'
                : 'Stored records'}
          </span>
          {!isReference && (
            <button
              className={styles.ghostButton}
              onClick={() => setRefresh((value) => value + 1)}
              disabled={browse.loading}
              type="button"
            >
              {browse.loading ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
        </div>
      </header>
      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <nav aria-label="World Model panels" className={styles.navigation}>
            {panels.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={panel === item.id ? 'page' : undefined}
                className={panel === item.id ? styles.navActive : undefined}
                onClick={() => changePanel(item.id)}
              >
                {item.label}
                <span>{item.description}</span>
              </button>
            ))}
          </nav>
          <div className={styles.sidebarNote}>
            <p>Built on Meterless</p>
            <a
              href="/meterless-world-model/README.md"
              target="_blank"
              rel="noreferrer"
            >
              Source &amp; license ↗
            </a>
            <Link to="/" className={styles.backLink}>
              ← Back to dashboard
            </Link>
          </div>
        </aside>
        <div className={styles.content}>
          {isReference ? (
            <ReferenceSandbox />
          ) : (
            <>
              {browse.data && (
                <div
                  className={styles.statistics}
                  aria-label="World Model totals"
                >
                  <Stat label="Records" value={browse.data.counts.records} />
                  <Stat
                    label="Relationships"
                    value={browse.data.counts.relationships}
                  />
                  <Stat label="Events" value={browse.data.counts.events} />
                  <div className={styles.scope}>
                    <span>Workspace</span>
                    <strong>{browse.data.scope.workspace}</strong>
                  </div>
                </div>
              )}
              {browse.error && (
                <div role="alert" className={styles.error}>
                  <p>{browse.error}</p>
                  <button
                    type="button"
                    className={styles.ghostButton}
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    Retry loading records
                  </button>
                </div>
              )}
              {panel === 'rebuild' ? (
                <section
                  className={styles.maintenance}
                  aria-labelledby="rebuild-title"
                >
                  <p className={styles.eyebrow}>Maintenance</p>
                  <h2 id="rebuild-title">Rebuild derived views</h2>
                  <p>
                    Replay the saved World Model events to restore the record
                    and relationship views for this workspace.
                  </p>
                  <p className={styles.muted}>
                    Evidence, record history, reviews and acceptance decisions
                    are preserved. Use the originating task to correct evidence
                    or request another review.
                  </p>
                  <dl className={styles.metadata}>
                    <div>
                      <dt>Execution mode</dt>
                      <dd>{browse.data?.scope.mode ?? 'Loading…'}</dd>
                    </div>
                    <div>
                      <dt>Projection cursor</dt>
                      <dd>{browse.data?.projection_cursor ?? '—'}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={rebuilding || !browse.data || browse.loading}
                    onClick={() => void rebuild()}
                  >
                    {rebuilding
                      ? 'Rebuilding views…'
                      : rebuildError
                        ? 'Retry rebuild'
                        : 'Rebuild projections'}
                  </button>
                  {rebuildError && (
                    <p role="alert" className={styles.error}>
                      {rebuildError}
                    </p>
                  )}
                  {rebuildResult && (
                    <p role="status" className={styles.success}>
                      Views rebuilt through event{' '}
                      {rebuildResult.projection_cursor}.
                      {rebuildResult.reused
                        ? ' The previous operation receipt was restored.'
                        : ''}
                    </p>
                  )}
                </section>
              ) : (
                <div className={styles.inspection}>
                  <section
                    className={styles.recordBrowser}
                    aria-label="Browse World Model records"
                  >
                    <div className={styles.sectionHeading}>
                      <h2>Inspect</h2>
                      <span>Current records</span>
                    </div>
                    <form className={styles.filters} onSubmit={filterRecords}>
                      <label htmlFor="world-kind">Record kind</label>
                      <select
                        id="world-kind"
                        value={kind}
                        onChange={(event) => {
                          const value = event.target.value;
                          setParams((current) => {
                            const next = new URLSearchParams(current);
                            if (value) next.set('kind', value);
                            else next.delete('kind');
                            next.delete('record');
                            return next;
                          });
                        }}
                      >
                        <option value="">All kinds</option>
                        {kind &&
                          !browse.data?.kinds.some(
                            (item) => item.kind === kind,
                          ) && <option value={kind}>{kind}</option>}
                        {browse.data?.kinds.map((item) => (
                          <option key={item.kind} value={item.kind}>
                            {item.kind} ({item.count})
                          </option>
                        ))}
                      </select>
                      <label htmlFor="world-query">Find a record</label>
                      <div className={styles.searchRow}>
                        <input
                          key={query}
                          id="world-query"
                          name="query"
                          type="search"
                          defaultValue={query}
                          placeholder="Record or source ID"
                          maxLength={256}
                        />
                        <button type="submit" className={styles.ghostButton}>
                          Search
                        </button>
                      </div>
                      {(kind || query) && (
                        <button
                          className={styles.textButton}
                          type="button"
                          onClick={() => setParams({})}
                        >
                          Clear filters
                        </button>
                      )}
                    </form>
                    {browse.loading && (
                      <p className={styles.empty} role="status">
                        Loading stored records…
                      </p>
                    )}
                    {browse.data && browse.data.records.length === 0 && (
                      <div className={styles.empty}>
                        <h3>
                          {kind || query
                            ? 'No matching records'
                            : 'No records yet'}
                        </h3>
                        <p>
                          {kind || query
                            ? 'Try another record kind or ID.'
                            : 'Run an evidence task to retain records here. Explore the reference sandbox to try Meterless with sample data.'}
                        </p>
                        {!kind && !query && <Link to="/">Start a task</Link>}
                      </div>
                    )}
                    <ul className={styles.recordList}>
                      {browse.data?.records.map((record) => (
                        <li key={record.ref.id}>
                          <button
                            type="button"
                            aria-pressed={selectedId === record.ref.id}
                            className={
                              selectedId === record.ref.id
                                ? styles.selectedRecord
                                : undefined
                            }
                            onClick={() => selectRecord(record.ref.id)}
                          >
                            <span className={styles.recordKind}>
                              {record.kind}
                              <span>v{record.ref.revision}</span>
                            </span>
                            <strong>{recordTitle(record)}</strong>
                            <span className={styles.recordId}>
                              {record.ref.id}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {browse.data?.has_more && (
                      <button
                        type="button"
                        className={styles.loadMore}
                        disabled={browse.appending}
                        onClick={() => void loadMore()}
                      >
                        {browse.appending
                          ? 'Loading more…'
                          : 'Load more records'}
                      </button>
                    )}
                    {browse.data?.kinds_truncated && (
                      <p className={styles.muted}>
                        The kind list is limited. Search by record ID to find
                        other records.
                      </p>
                    )}
                  </section>
                  {selectedId ? (
                    <WorldModelRecord
                      key={selectedId + ':' + refresh}
                      recordId={selectedId}
                      onSelect={selectRecord}
                    />
                  ) : (
                    <section
                      className={styles.inspectorEmpty}
                      aria-label="Record detail"
                    >
                      <span className={styles.emptyIcon} aria-hidden="true">
                        ◇
                      </span>
                      <h2>A connected view of your evidence</h2>
                      <p>
                        Select a record to inspect its retained data, supporting
                        relationships and history.
                      </p>
                    </section>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

export function ReferenceSandbox() {
  return (
    <section className={styles.reference} aria-labelledby="reference-title">
      <div className={styles.referenceHeading}>
        <div>
          <p className={styles.eyebrow}>Meterless reference</p>
          <h2 id="reference-title">Try the original control plane</h2>
        </div>
        <span className={styles.mode}>Sample data · disposable</span>
      </div>
      <p className={styles.referenceNotice}>
        This sandbox runs Meterless’s original engine with sample data. Changes
        stay in this sandbox and reset when it is reopened. Your Haze records
        are separate.
      </p>
      <iframe
        title="Meterless World Model reference sandbox"
        src="/meterless-world-model/live.html"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className={styles.referenceFrame}
      />
    </section>
  );
}
