import { useState } from 'react';
import type { TaskEvent, TaskRecord } from '../../../../app/contracts/tasks.ts';
import styles from './TaskExecutionReceipts.module.css';

function duration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Unavailable';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(2)} s`;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
}

function Timestamp({ at }: { at: string }) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return <>Unavailable</>;
  const iso = date.toISOString();
  return (
    <time dateTime={at} title={iso} className={styles.timestamp}>
      <span>{iso.slice(0, 10)}</span>
      <span>{iso.slice(11, 23)} UTC</span>
    </time>
  );
}

function ReceiptRow({
  receipt,
  record,
  previous,
  number,
}: {
  receipt: TaskEvent;
  record: TaskRecord;
  previous?: TaskEvent;
  number: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = `receipt-${receipt.task_id}-${receipt.cursor}`;
  const at = Date.parse(receipt.at);
  const assignment = receipt.assignment_id
    ? record.assignments.find((item) => item.id === receipt.assignment_id)
    : undefined;
  const measured =
    receipt.data &&
    typeof receipt.data === 'object' &&
    !Array.isArray(receipt.data)
      ? receipt.data.duration_ms
      : undefined;
  const execution =
    typeof measured === 'number' && Number.isFinite(measured) && measured >= 0
      ? duration(measured)
      : null;
  const previousTime =
    previous?.run_id === receipt.run_id ? Date.parse(previous.at) : NaN;

  return (
    <>
      <tr>
        <td className={styles.numeric}>{number}</td>
        <th scope="row">{receipt.actor}</th>
        <td className={styles.message}>
          <span className={styles.eventType}>{receipt.type}</span>
          <p>{receipt.message}</p>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            aria-label={`${expanded ? 'Hide' : 'Show'} details for receipt ${receipt.cursor}`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Hide details' : 'Receipt details'}
          </button>
        </td>
        <td>
          <Timestamp at={receipt.at} />
        </td>
        <td className={styles.numeric}>
          {duration(at - Date.parse(record.created_at))}
          {Number.isFinite(previousTime) && at >= previousTime && (
            <span className={styles.secondary}>
              +{duration(at - previousTime)} since previous
            </span>
          )}
        </td>
        <td className={styles.numeric}>
          {execution ?? <span className={styles.secondary}>Not recorded</span>}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} id={detailId} className={styles.detailCell}>
            <dl className={styles.context}>
              <div>
                <dt>Event cursor</dt>
                <dd>{receipt.cursor}</dd>
              </div>
              <div>
                <dt>Run ID</dt>
                <dd>{receipt.run_id}</dd>
              </div>
              <div>
                <dt>Objective revision</dt>
                <dd>{receipt.objective_revision}</dd>
              </div>
              <div>
                <dt>Generation</dt>
                <dd>{receipt.generation}</dd>
              </div>
              {receipt.assignment_id && (
                <div>
                  <dt>Assignment</dt>
                  <dd>
                    {assignment && <span>{assignment.definition_id} · </span>}
                    {receipt.assignment_id}
                  </dd>
                </div>
              )}
            </dl>
            {receipt.data !== undefined && (
              <>
                <p className={styles.metadataLabel}>Recorded metadata</p>
                <pre className={styles.metadata}>
                  {JSON.stringify(receipt.data, null, 2)}
                </pre>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function TaskExecutionReceipts({
  record,
  receipts,
}: {
  record: TaskRecord;
  receipts: TaskEvent[];
}) {
  // Cursor order is durable across reconnects, even if a wall clock moves back.
  const ordered = receipts.toSorted(
    (left, right) => left.cursor - right.cursor,
  );
  const lastUpdate = ordered.reduce(
    (latest, receipt) => Math.max(latest, Date.parse(receipt.at)),
    Date.parse(record.updated_at),
  );
  return (
    <div className={styles.receipts}>
      <dl className={styles.metrics}>
        <div>
          <dt>Task elapsed</dt>
          <dd>{duration(lastUpdate - Date.parse(record.created_at))}</dd>
        </div>
        <div>
          <dt>Model calls</dt>
          <dd>{record.usage.model_calls}</dd>
        </div>
        <div>
          <dt>Tool calls</dt>
          <dd>{record.usage.tool_calls}</dd>
        </div>
        <div>
          <dt>Assignments</dt>
          <dd>{record.usage.assignments}</dd>
        </div>
      </dl>
      <p className={styles.note}>
        Elapsed time runs from task creation through the latest saved update,
        including queue and waiting time. Execution is the measured operation
        duration when recorded. All timestamps are UTC.
      </p>
      {ordered.length > 0 ? (
        <div
          className={styles.tableWrap}
          role="region"
          aria-label="Task execution receipts"
          tabIndex={0}
        >
          <table className={styles.table}>
            <caption className={styles.caption}>
              Task event timing and execution details
            </caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Actor</th>
                <th scope="col">Event / message</th>
                <th scope="col">Recorded at</th>
                <th scope="col">Task elapsed</th>
                <th scope="col">Execution time</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((receipt, index) => (
                <ReceiptRow
                  key={receipt.cursor}
                  receipt={receipt}
                  record={record}
                  previous={ordered[index - 1]}
                  number={index + 1}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.note}>
          No execution receipts have been recorded yet.
        </p>
      )}
    </div>
  );
}
