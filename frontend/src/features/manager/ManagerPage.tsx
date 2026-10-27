import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { TaskControls } from './TaskControls.tsx';
import { NextTaskPermissions } from './NextTaskPermissions.tsx';
import { TaskQuestions } from '../chat/TaskQuestions.tsx';
import { useAgentRun, type AgentRun } from '../dashboard/useAgentRun.ts';
import { ManagerWorkspace } from '../task-report/ManagerWorkspace.tsx';
import { Badge } from '../../shared/ui/Badge.tsx';
import { Button, buttonClass } from '../../shared/ui/Button.tsx';
import { Spinner } from '../../shared/ui/States.tsx';
import styles from './ManagerPage.module.css';
import { BackLink } from '../../shared/ui/BackLink.tsx';

function savedTaskId(): string | undefined {
  try {
    return (
      sessionStorage.getItem('haze.general.task.id') ??
      sessionStorage.getItem('haze.manager.task.id') ??
      undefined
    );
  } catch {
    return undefined;
  }
}

/** Explicit task links take precedence over the dashboard's saved task. */
export function ManagerPage() {
  const { taskId } = useParams();
  const selectedId = taskId ?? savedTaskId();
  return selectedId ? (
    <ManagerTaskPage key={selectedId} taskId={selectedId} />
  ) : (
    <article className={styles.page}>
      <PageHeader />
      <NextTaskPermissions />
      <section className={styles.empty}>
        <h2>No task selected</h2>
        <p>
          Start a task from the dashboard, then open its Manager workspace to
          follow the plan, assignments and decisions.
        </p>
        <Link to="/dashboard" className={buttonClass('primary')}>
          Start a task on the dashboard
        </Link>
      </section>
      <TaskPicker />
    </article>
  );
}

function ManagerTaskPage({ taskId }: { taskId: string }) {
  // Viewing a different saved task must not replace the dashboard's task.
  const run = useAgentRun(taskId, 'haze.manager.task.id');
  return <ManagerTaskView taskId={taskId} run={run} />;
}

function PageHeader({ taskId }: { taskId?: string }) {
  return (
    <header className={styles.header}>
      <nav className={styles.actions} aria-label="Manager navigation">
        <BackLink>Back to the dashboard</BackLink>
        {taskId && (
          <Link
            to={`/task/${encodeURIComponent(taskId)}`}
            className={buttonClass('secondary', 'small')}
          >
            Open task report
          </Link>
        )}
      </nav>
      <h1>Manager</h1>
      <p>Follow the plan, assignments and decisions for your task.</p>
    </header>
  );
}

/** Reuses saved task readback and controls, including live observation. */
export function ManagerTaskView({
  taskId,
  run,
}: {
  taskId: string;
  run: AgentRun;
}) {
  const record = run.task?.id === taskId ? run.task.record : undefined;
  const error =
    run.observationError ??
    (!record ? run.operationError : null) ??
    (record && ['failed', 'timed_out'].includes(record.status)
      ? record.error?.message
      : null);
  const loading = !record && run.status === 'idle' && !error;
  const observing = ['running', 'waiting', 'paused'].includes(run.status);
  const hasManager = record?.manager?.run_id === record?.current_run_id;
  return (
    <article className={styles.page} aria-busy={loading}>
      <PageHeader taskId={record ? taskId : undefined} />
      <NextTaskPermissions />
      <TaskPicker taskId={taskId} />
      <div className={styles.status}>
        {record && (
          <>
            <p className={styles.objective}>
              <span className={styles.label}>Original objective</span>
              {record.original_request.objective}
            </p>
            <p className={styles.meta}>
              <Badge tone={record.status === 'failed' ? 'warn' : 'neutral'}>
                Task: {record.status.replaceAll('_', ' ')}
              </Badge>
              <span>Execution mode: {record.mode}.</span>
              <span>
                Last saved:{' '}
                <time dateTime={record.updated_at}>{record.updated_at}</time>
              </span>
            </p>
          </>
        )}
        <p role="status" className={styles.note}>
          {loading && <Spinner />}
          {loading ? 'Loading the saved task...' : run.statusText}
        </p>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {observing && (
          <Button size="small" variant="ghost" onClick={run.cancel}>
            Stop waiting
          </Button>
        )}
      </div>
      {record && (
        <>
          {hasManager ? (
            <ManagerWorkspace record={record} />
          ) : (
            <p className={styles.empty}>
              No Manager workspace is saved for this run yet. Its task report
              remains available above.
            </p>
          )}
          <section
            className={styles.status}
            aria-label="Task controls and clarification"
          >
            <h2>Task controls</h2>
            <TaskControls run={run} />
            <TaskQuestions run={run} />
          </section>
        </>
      )}
    </article>
  );
}

function TaskPicker({ taskId = '' }: { taskId?: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState(taskId);
  const [error, setError] = useState<string | null>(null);
  const openTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = value.trim();
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      setError('Enter a valid task ID from a saved task report.');
      return;
    }
    navigate(`/manager/${encodeURIComponent(id)}`);
  };
  return (
    <details className={styles.picker} open={!taskId}>
      <summary>
        {taskId ? 'Open another saved task' : 'Open a saved task'}
      </summary>
      <form onSubmit={openTask} className={styles.form}>
        <label htmlFor="manager-task-id">Task ID</label>
        <div className={styles.taskInput}>
          <input
            id="manager-task-id"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            required
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'manager-task-error' : undefined}
          />
          <Button type="submit">Open task</Button>
        </div>
        {error && (
          <p id="manager-task-error" role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </form>
    </details>
  );
}
