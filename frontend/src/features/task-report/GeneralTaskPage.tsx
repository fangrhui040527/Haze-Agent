import { useMemo } from 'react';
import { Link } from 'react-router';
import { TaskQuestions } from '../chat/TaskQuestions.tsx';
import { TaskResult } from '../chat/TaskResult.tsx';
import { useAgentRun, type AgentRun } from '../dashboard/useAgentRun.ts';
import { WorldModelStatus } from './WorldModelStatus.tsx';
import {
  useWorldModelStatus,
  type WorldModelStatusState,
} from './useWorldModelStatus.ts';
import { Badge } from '../../shared/ui/Badge.tsx';
import { Button, buttonClass } from '../../shared/ui/Button.tsx';
import { Spinner } from '../../shared/ui/States.tsx';
import styles from './TaskPage.module.css';
import { BackLink } from '../../shared/ui/BackLink.tsx';
import { ExternalWaitObserver } from '../nightshift/ExternalWaits.tsx';
import { useSmokeLedgerTrace } from '../chat/SmokeLedgerGlobe.tsx';
import { SmokeLedgerReport, readSmokeTrace } from './SmokeLedgerReport.tsx';

const SMOKELEDGER_CAPABILITY = 'smokeledger-episode';
const NO_PRODUCTS: never[] = [];

/** Restore this report's identity rather than whichever task was last open. */
export function GeneralTaskPage({ taskId }: { taskId: string }) {
  const run = useAgentRun(taskId);
  const record = run.task?.id === taskId ? run.task.record : undefined;
  const lifecycleCursor = run.events.reduce(
    (cursor, event) =>
      event.type === 'task_event' &&
      event.receipt.type === 'world_lifecycle_changed'
        ? Math.max(cursor, event.receipt.cursor)
        : cursor,
    0,
  );
  const worldModel = useWorldModelStatus(
    taskId,
    record?.state_revision,
    lifecycleCursor,
    record !== undefined,
  );
  return (
    <GeneralTaskReport taskId={taskId} run={run} worldModel={worldModel} />
  );
}

/** The report renders saved state and actual receipts without simulated steps. */
export function GeneralTaskReport({
  taskId,
  run,
  worldModel,
}: {
  taskId: string;
  run: AgentRun;
  worldModel?: WorldModelStatusState;
}) {
  const task = run.task?.id === taskId ? run.task : null;
  const record = task?.record;
  const smoke = Boolean(
    record?.assignments.some(
      (assignment) => assignment.capability === SMOKELEDGER_CAPABILITY,
    ),
  );
  const content = useSmokeLedgerTrace(
    smoke && record?.result ? record.result.work_products : NO_PRODUCTS,
  );
  const trace = useMemo(() => readSmokeTrace(content), [content]);
  if (!smoke)
    return (
      <article
        className={styles.page}
        aria-busy={!record || run.status === 'running'}
      >
        <BackLink>Back to the dashboard</BackLink>
        <ReportDetails taskId={taskId} run={run} worldModel={worldModel} />
      </article>
    );
  const error =
    record?.error?.message ??
    run.observationError ??
    (record && ['failed', 'timed_out'].includes(record.status)
      ? `The trace ended with status ${record.status.replace('_', ' ')}.`
      : null);
  return (
    <article className={styles.page} aria-busy={!trace && !error}>
      <BackLink>Back to the dashboard</BackLink>
      {trace && record?.result ? (
        <SmokeLedgerReport
          trace={trace}
          content={content}
          result={record.result}
        />
      ) : (
        <div className={styles.doc}>
          <h1 className={styles.title}>Where did the smoke come from?</h1>
          {record && (
            <blockquote className={styles.quote}>
              <span className={styles.label}>You asked</span>
              <p className={styles.block}>
                {record.original_request.objective}
              </p>
            </blockquote>
          )}
          {error ? (
            <p className={styles.error} role="alert">
              The trace did not finish. {error}
            </p>
          ) : (
            <p className={styles.placeholder} role="status">
              <Spinner />{' '}
              {record?.result
                ? 'Loading the result…'
                : 'Tracing the smoke back to its source and checking the result. This usually takes 3–4 minutes; this page updates by itself.'}
            </p>
          )}
          {record && <TaskQuestions run={run} />}
        </div>
      )}
      <details>
        <summary>Technical details (for reviewers)</summary>
        <ReportDetails taskId={taskId} run={run} worldModel={worldModel} />
      </details>
    </article>
  );
}

/** Saved state, receipts, review checks and World Model status, in full. */
function ReportDetails({
  taskId,
  run,
  worldModel,
}: {
  taskId: string;
  run: AgentRun;
  worldModel?: WorldModelStatusState;
}) {
  const task = run.task?.id === taskId ? run.task : null;
  const record = task?.record;
  const error =
    record?.error?.message ??
    run.observationError ??
    (!record ? run.operationError : null) ??
    (record && ['failed', 'timed_out'].includes(record.status)
      ? `Task ended with server status ${record.status}.`
      : null) ??
    (run.status === 'failed' ? 'Task observation failed.' : null);
  const loading = !record && run.status === 'idle' && !error;
  const observing = ['running', 'waiting', 'paused'].includes(run.status);
  const receipts = run.events.flatMap((event) =>
    event.type === 'task_event' && event.receipt.task_id === taskId
      ? [event.receipt]
      : [],
  );
  return (
    <>
      <div className={styles.doc}>
        <h1 className={styles.title}>Task report</h1>
        {record && (
          <blockquote className={styles.quote}>
            <span className={styles.label}>Original objective</span>
            <p className={styles.block}>{record.original_request.objective}</p>
          </blockquote>
        )}
        <p className={styles.meta}>
          {record && (
            <>
              <Badge tone={record.status === 'failed' ? 'warn' : 'neutral'}>
                Server task: {record.status}
              </Badge>
              <span>Execution mode: {record.mode}.</span>
              <span>
                Last saved:{' '}
                <time dateTime={record.updated_at}>{record.updated_at}</time>
              </span>
            </>
          )}
        </p>
        <p className={styles.placeholder} role="status">
          {(loading || run.status === 'running') && <Spinner />}
          {loading ? 'Loading the saved task...' : run.statusText}
        </p>
        {observing && (
          <Button size="small" variant="ghost" onClick={run.cancel}>
            Stop waiting
          </Button>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {record && (
          <>
            <TaskQuestions run={run} />
          </>
        )}
        {record && worldModel && <WorldModelStatus state={worldModel} />}
        {record && <ExternalWaitObserver taskId={record.id} />}
      </div>
      {record && (
        <p className={styles.back}>
          <Link
            to={`/manager/${encodeURIComponent(record.id)}`}
            className={buttonClass('secondary', 'small')}
          >
            Open Manager workspace
          </Link>
        </p>
      )}
      <details open={!record?.result || observing}>
        <summary>Actual execution receipts ({receipts.length})</summary>
        {receipts.length > 0 ? (
          <ol className={styles.steps}>
            {receipts.map((receipt) => (
              <li key={receipt.cursor}>
                <div>
                  <p className={styles.block}>
                    <strong>{receipt.actor}</strong>: {receipt.message}
                  </p>
                  <small>
                    <time dateTime={receipt.at}>{receipt.at}</time> -{' '}
                    {receipt.type} - run {receipt.run_id}, revision{' '}
                    {receipt.objective_revision}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.placeholder}>
            No execution receipts loaded yet.
          </p>
        )}
      </details>
      {record?.result && task && (
        <section className={styles.doc} aria-labelledby="task-result-title">
          <h2 id="task-result-title" className={styles.heading}>
            Saved result
          </h2>
          <TaskResult
            evidence={{
              taskUrl: task.taskUrl,
              result: record.result,
              objectiveRevision: record.objective_revision,
              runId: record.current_run_id,
            }}
            showAnswer
            linkToReport={false}
          />
        </section>
      )}
      {task && (
        <p className={styles.back}>
          <a href={task.taskUrl} target="_blank" rel="noreferrer">
            Saved task record
          </a>
        </p>
      )}
    </>
  );
}
