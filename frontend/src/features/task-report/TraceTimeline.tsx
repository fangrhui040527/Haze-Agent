import { useEffect, useRef, useState } from 'react';
import type { TaskRecord } from '../../../../app/contracts/tasks.ts';
import type { TracePage } from '../../../../app/contracts/trace-export.ts';
import { isTraceHighlight } from '../../../../app/tasks/trace-summary.ts';
import type { AgentService } from '../../services/agents/AgentService.ts';
import { agentService } from '../../services/agents/index.ts';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './TaskPage.module.css';

export interface TraceState {
  taskId: string;
  runId: string;
  page: TracePage | null;
  loading: boolean;
  error: string | null;
}

/** Abort and identity checks both protect against transports that ignore cancellation. */
export async function readTracePage(
  service: AgentService,
  taskId: string,
  runId: string,
  after: number,
  signal: AbortSignal,
): Promise<TracePage | null> {
  if (!service.readTrace)
    throw new Error('Execution trace is unavailable in this task service.');
  const page = await service.readTrace(taskId, runId, after, signal);
  if (signal.aborted) return null;
  if (
    page.task_id !== taskId ||
    page.run_id !== runId ||
    page.records.some(
      (record) =>
        record.task_id !== taskId ||
        record.run_id !== runId ||
        record.cursor <= after,
    )
  )
    throw new Error(
      'The trace response does not match the selected task and run.',
    );
  if (page.has_more && page.next_cursor <= after)
    throw new Error('The trace response did not advance its cursor.');
  let previous = after;
  for (const item of page.records) {
    if (item.cursor <= previous)
      throw new Error('Trace records are out of cursor order.');
    previous = item.cursor;
  }
  if (page.next_cursor !== previous)
    throw new Error(
      'The trace continuation cursor does not match its records.',
    );
  return page;
}

export function TraceTimeline({
  record,
  service = agentService,
}: {
  record: TaskRecord;
  service?: AgentService;
}) {
  const [showAll, setShowAll] = useState(false);
  const [selection, setSelection] = useState<{
    taskId: string;
    runId: string;
  } | null>(null);
  const runId =
    selection?.taskId === record.id &&
    record.runs.some((run) => run.id === selection.runId)
      ? selection.runId
      : record.current_run_id;
  const [state, setState] = useState<TraceState>({
    taskId: record.id,
    runId,
    page: null,
    loading: true,
    error: null,
  });
  const pending = useRef<AbortController | null>(null);
  const visible =
    state.taskId === record.id && state.runId === runId ? state : null;

  useEffect(() => {
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    setState({
      taskId: record.id,
      runId,
      page: null,
      loading: true,
      error: null,
    });
    readTracePage(service, record.id, runId, 0, controller.signal)
      .then((page) => {
        if (page)
          setState({
            taskId: record.id,
            runId,
            page,
            loading: false,
            error: null,
          });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            taskId: record.id,
            runId,
            page: null,
            loading: false,
            error:
              error instanceof Error
                ? error.message
                : 'Execution trace could not be loaded.',
          });
      });
    return () => pending.current?.abort();
  }, [record.id, record.state_revision, runId, service]);

  async function more() {
    const page = visible?.page;
    if (!page || visible.loading) return;
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const next = await readTracePage(
        service,
        record.id,
        runId,
        page.next_cursor,
        controller.signal,
      );
      if (next)
        setState({
          taskId: record.id,
          runId,
          page: {
            ...next,
            records: [...page.records, ...next.records],
            completeness: {
              native: page.completeness.native + next.completeness.native,
              reconstructed:
                page.completeness.reconstructed +
                next.completeness.reconstructed,
              omissions: [
                ...new Set([
                  ...page.completeness.omissions,
                  ...next.completeness.omissions,
                ]),
              ],
            },
          },
          loading: false,
          error: null,
        });
    } catch (error) {
      if (!controller.signal.aborted)
        setState((current) => ({
          ...current,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : 'More trace records could not be loaded.',
        }));
    }
  }
  const unavailable = !service.readTrace
    ? 'Execution trace is unavailable in this task service.'
    : visible?.error;
  const page = visible?.page;
  const shown = page?.records.filter(
    (item) => showAll || isTraceHighlight(item),
  );
  const ids = new Set(shown?.map((item) => item.event_id));
  return (
    <section
      className={styles.doc}
      aria-labelledby="trace-title"
      aria-busy={visible?.loading ?? true}
    >
      <h2 id="trace-title" className={styles.heading}>
        Execution timeline
      </h2>
      <label>
        Trace run{' '}
        <select
          value={runId}
          onChange={(event) => {
            pending.current?.abort();
            setSelection({ taskId: record.id, runId: event.target.value });
          }}
        >
          {record.runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.id}
              {run.id === record.current_run_id
                ? ' (current)'
                : ' (historical)'}
            </option>
          ))}
        </select>
      </label>
      <p>
        {runId === record.current_run_id
          ? 'Showing the current run trace.'
          : 'Showing a historical run trace. The saved-result panel below belongs to the current task state.'}
      </p>
      {service.readTrace && service.traceDownloadUrl && (
        <p className={styles.meta}>
          <a
            href={service.traceDownloadUrl(record.id, runId, 'jsonl')}
            download
          >
            Download JSONL
          </a>{' '}
          <a
            href={service.traceDownloadUrl(record.id, runId, 'bundle')}
            download
          >
            Download evidence bundle
          </a>
        </p>
      )}
      {unavailable && <p role="status">{unavailable}</p>}
      {!unavailable && !page && <p role="status">Loading execution trace...</p>}
      {page && (
        <>
          <label>
            <input
              type="checkbox"
              checked={showAll}
              onChange={(event) => setShowAll(event.target.checked)}
            />{' '}
            Show all captured events
          </label>
          <p className={styles.meta}>
            {page.active_snapshot ? 'Active run snapshot' : 'Saved run'} ·
            snapshot cursor {page.snapshot_cursor} · {page.completeness.native}{' '}
            captured, {page.completeness.reconstructed} reconstructed.
          </p>
          {page.completeness.omissions.length > 0 && (
            <p>Unavailable context: {page.completeness.omissions.join(' ')}</p>
          )}
          {page.sink_health && (
            <details className={styles.traceDetails}>
              <summary>Trace delivery health</summary>
              <pre>{JSON.stringify(page.sink_health, null, 2)}</pre>
            </details>
          )}
          <ol className={styles.steps}>
            {shown?.map((item) => (
              <li key={item.event_id} id={`trace-${item.event_id}`}>
                <div>
                  <p className={styles.block}>
                    <strong>{item.actor}</strong>: {item.summary}
                  </p>
                  <small>
                    <time dateTime={item.at}>{item.at}</time> · {item.action} ·{' '}
                    {item.status} · {item.event_id}
                  </small>
                  {(item.evidence_verdict ||
                    item.execution_status ||
                    item.task_status) && (
                    <p>
                      {item.execution_status && (
                        <>Execution: {item.execution_status}. </>
                      )}
                      {item.evidence_verdict && (
                        <>Evidence review: {item.evidence_verdict}. </>
                      )}
                      {item.task_status && <>Task: {item.task_status}.</>}
                    </p>
                  )}
                  <details className={styles.traceDetails}>
                    <summary>Technical details and evidence</summary>
                    <p>
                      Capture: {item.provenance.capture} · mode:{' '}
                      {item.provenance.mode}
                    </p>
                    {(item.causes.decision_id ||
                      item.causes.attempt_id ||
                      item.causes.message_id) && (
                      <p>
                        Direct causes:{' '}
                        {[
                          item.causes.decision_id,
                          item.causes.attempt_id,
                          item.causes.message_id,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </p>
                    )}
                    {item.causes.event_ids.length > 0 && (
                      <p>
                        Caused by:{' '}
                        {item.causes.event_ids.map((id) => (
                          <span key={id}>
                            {ids.has(id) ? (
                              <a href={`#trace-${id}`}>{id}</a>
                            ) : (
                              id
                            )}{' '}
                          </span>
                        ))}
                      </p>
                    )}
                    {item.artifacts.length > 0 && (
                      <ul>
                        {item.artifacts.map((ref) => (
                          <li key={`${ref.id}:${ref.version}:${ref.sha256}`}>
                            Artifact {ref.id}, version {ref.version}, SHA-256{' '}
                            {ref.sha256}
                          </li>
                        ))}
                      </ul>
                    )}
                    {item.supersedes &&
                      (item.supersedes.event_ids.length > 0 ||
                        item.supersedes.artifacts.length > 0) && (
                        <div>
                          <p>Replaces earlier work or review:</p>
                          {item.supersedes.event_ids.length > 0 && (
                            <p>
                              {item.supersedes.event_ids.map((id) => (
                                <span key={id}>
                                  {ids.has(id) ? (
                                    <a href={`#trace-${id}`}>{id}</a>
                                  ) : (
                                    id
                                  )}{' '}
                                </span>
                              ))}
                            </p>
                          )}
                          {item.supersedes.artifacts.length > 0 && (
                            <ul>
                              {item.supersedes.artifacts.map((ref) => (
                                <li
                                  key={`${ref.id}:${ref.version}:${ref.sha256}`}
                                >
                                  Replaced artifact {ref.id}, version{' '}
                                  {ref.version}, SHA-256 {ref.sha256}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    <pre>{JSON.stringify(item, null, 2)}</pre>
                  </details>
                </div>
              </li>
            ))}
          </ol>
          {!page.records.length && (
            <p>No execution trace records are available for this run.</p>
          )}
          {page.has_more && (
            <Button
              size="small"
              variant="secondary"
              disabled={visible?.loading}
              onClick={() => void more()}
            >
              {visible?.loading ? 'Loading...' : 'Load more trace events'}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
