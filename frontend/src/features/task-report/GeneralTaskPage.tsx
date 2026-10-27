import { Link } from 'react-router';
import { TaskQuestions } from '../chat/TaskQuestions.tsx';
import { TaskResult } from '../chat/TaskResult.tsx';
import { useAgentRun, type AgentRun } from '../dashboard/useAgentRun.ts';
import { WorldModelStatus } from './WorldModelStatus.tsx';
import {
  useWorldModelStatus,
  type WorldModelStatusState,
} from './useWorldModelStatus.ts';
import type { TaskRecord } from '../../../../app/contracts/tasks.ts';
import { Badge, type Tone } from '../../shared/ui/Badge.tsx';
import { Button, buttonClass } from '../../shared/ui/Button.tsx';
import { Spinner } from '../../shared/ui/States.tsx';
import styles from './TaskPage.module.css';
import { BackLink } from '../../shared/ui/BackLink.tsx';
import { ExternalWaitObserver } from '../nightshift/ExternalWaits.tsx';
import { TraceTimeline } from './TraceTimeline.tsx';
import { timeAgo } from '../../shared/lib/time.ts';

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

const STATUS: Record<TaskRecord['status'], { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  waiting: { label: 'Waiting for input', tone: 'info' },
  paused: { label: 'Paused', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'error' },
  timed_out: { label: 'Timed out', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const STOPPED: Partial<Record<TaskRecord['status'], string>> = {
  timed_out: 'The run reached its deadline before finishing.',
  failed: 'The run stopped with an error.',
  cancelled: 'This task was cancelled.',
};

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
  const status = record ? STATUS[record.status] : null;
  const error =
    record?.error?.message ??
    run.observationError ??
    (!record ? run.operationError : null) ??
    (record && ['failed', 'timed_out'].includes(record.status)
      ? `Task ${STATUS[record.status].label.toLowerCase()}.`
      : null) ??
    (run.status === 'failed' ? 'Task observation failed.' : null);
  const loading = !record && run.status === 'idle' && !error;
  const observing = ['running', 'waiting', 'paused'].includes(run.status);
  const statusText = loading ? 'Loading the saved task...' : run.statusText;
  const stopped = record ? STOPPED[record.status] : undefined;
  const openQuestions =
    record?.questions.some((question) => question.status === 'open') ?? false;
  const nextStep = Boolean(stopped) || openQuestions;
  return (
    <article
      className={styles.page}
      aria-busy={loading || run.status === 'running'}
    >
      <BackLink>Back to the dashboard</BackLink>
      <div className={styles.doc}>
        <span className={styles.label}>Task report</span>
        <h1 className={styles.title}>
          {record?.original_request.objective ?? 'Task report'}
        </h1>
        {record && status && (
          <p className={styles.meta}>
            <Badge tone={status.tone}>{status.label}</Badge>
            {record.mode !== 'live' && <Badge>{record.mode} mode</Badge>}
            <span>
              Updated{' '}
              <time
                dateTime={record.updated_at}
                title={new Date(record.updated_at).toLocaleString()}
              >
                {timeAgo(record.updated_at, Date.now())}
              </time>
            </span>
          </p>
        )}
        {(loading || (run.status !== 'idle' && statusText !== error)) && (
          <p className={styles.placeholder} role="status">
            {(loading || run.status === 'running') && <Spinner />}
            {statusText}
            {observing && (
              <Button size="small" variant="ghost" onClick={run.cancel}>
                Stop waiting
              </Button>
            )}
          </p>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {record &&
          (nextStep ? (
            <section
              className={styles.nextStep}
              aria-labelledby="next-step-title"
            >
              <h2 id="next-step-title" className={styles.heading}>
                Next step
              </h2>
              {stopped && (
                <>
                  <p className={styles.block}>
                    {stopped} Continue to start a linked run with fresh
                    resources; saved work is kept.
                  </p>
                  <Button
                    size="small"
                    onClick={() => void run.control('continue').catch(() => {})}
                    disabled={run.operationPending}
                  >
                    Continue in a new run
                  </Button>
                </>
              )}
              <TaskQuestions run={run} />
              {run.operationPending && (
                <p role="status">Saving task change...</p>
              )}
              {run.operationError && (
                <p className={styles.error} role="alert">
                  {run.operationError}
                </p>
              )}
            </section>
          ) : (
            <TaskQuestions run={run} />
          ))}
        {record && worldModel?.data?.records.length ? (
          <WorldModelStatus state={worldModel} />
        ) : null}
        {record && <ExternalWaitObserver taskId={record.id} compact />}
      </div>
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
      {record && (
        <TraceTimeline
          record={record}
          defaultCollapsed={Boolean(record.result) || nextStep}
        />
      )}
      {record && task && (
        <p className={styles.back}>
          <Link
            to={`/manager/${encodeURIComponent(record.id)}`}
            className={buttonClass('secondary', 'small')}
          >
            Open Manager workspace
          </Link>{' '}
          <a href={task.taskUrl} target="_blank" rel="noreferrer">
            Saved task record
          </a>
        </p>
      )}
    </article>
  );
}
