import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { agentService } from '../../services/agents/index.ts';
import type { TaskSummary } from '../../services/agents/AgentService.ts';
import { Badge, type Tone } from '../../shared/ui/Badge.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './TaskHistory.module.css';

interface HistoryState {
  tasks: TaskSummary[];
  nextCursor?: string;
  pending: boolean;
  error: string | null;
}

const initialState: HistoryState = {
  tasks: [],
  pending: true,
  error: null,
};

const statusTones: Record<TaskSummary['status'], Tone> = {
  queued: 'neutral',
  running: 'info',
  waiting: 'warn',
  paused: 'warn',
  completed: 'ok',
  cancelled: 'stale',
  failed: 'error',
  timed_out: 'error',
};

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function TaskHistory({
  currentTaskId,
  refreshKey,
}: {
  currentTaskId?: string;
  refreshKey: string;
}) {
  const [state, setState] = useState<HistoryState>(initialState);
  const [refresh, setRefresh] = useState(0);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    setState((previous) => ({ ...previous, pending: true, error: null }));
    if (!agentService.listTasks) {
      setState({
        tasks: [],
        pending: false,
        error: 'Task history is unavailable with this task service.',
      });
      return () => controller.abort();
    }
    agentService
      .listTasks({ limit: 10 }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted)
          setState({
            tasks: page.tasks,
            nextCursor: page.next_cursor,
            pending: false,
            error: null,
          });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            pending: false,
            error:
              cause instanceof Error
                ? cause.message
                : 'Saved tasks could not be loaded.',
          }));
      });
    return () => {
      controller.abort();
      requestRef.current?.abort();
    };
  }, [refresh, refreshKey]);

  const loadMore = async () => {
    if (state.pending || !state.nextCursor || !agentService.listTasks) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setState((previous) => ({ ...previous, pending: true, error: null }));
    try {
      const page = await agentService.listTasks(
        { limit: 10, cursor: state.nextCursor },
        controller.signal,
      );
      if (!controller.signal.aborted)
        setState((previous) => {
          const existing = new Set(previous.tasks.map((task) => task.id));
          return {
            tasks: [
              ...previous.tasks,
              ...page.tasks.filter((task) => !existing.has(task.id)),
            ],
            nextCursor: page.next_cursor,
            pending: false,
            error: null,
          };
        });
    } catch (cause) {
      if (!controller.signal.aborted)
        setState((previous) => ({
          ...previous,
          pending: false,
          error:
            cause instanceof Error
              ? cause.message
              : 'More saved tasks could not be loaded.',
        }));
    }
  };

  return (
    <TaskHistoryView
      {...state}
      currentTaskId={currentTaskId}
      onRefresh={() => setRefresh((value) => value + 1)}
      onLoadMore={() => void loadMore()}
    />
  );
}

export function TaskHistoryView({
  tasks,
  nextCursor,
  pending,
  error,
  currentTaskId,
  onRefresh,
  onLoadMore,
}: HistoryState & {
  currentTaskId?: string;
  onRefresh: () => void;
  onLoadMore: () => void;
}) {
  return (
    <section
      className={styles.history}
      aria-labelledby="task-history-heading"
      aria-busy={pending}
    >
      <div className={styles.heading}>
        <h2 id="task-history-heading" className={styles.title}>
          Task history
        </h2>
        <Button
          size="small"
          variant="ghost"
          disabled={pending}
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>
      <p className={styles.note}>
        Saved tasks in this workspace. Select a task to open its report.
      </p>
      {error && (
        <div className={styles.error}>
          <p role="alert">{error}</p>
          <Button size="small" disabled={pending} onClick={onRefresh}>
            Try again
          </Button>
        </div>
      )}
      {tasks.length > 0 ? (
        <ul className={styles.list} aria-label="Saved tasks">
          {tasks.map((task) => (
            <li key={task.id}>
              <Link
                to={`/task/${encodeURIComponent(task.id)}`}
                className={styles.task}
              >
                <span className={styles.objective}>{task.objective}</span>
                <span className={styles.meta}>
                  <Badge tone={statusTones[task.status]}>
                    {task.status.replaceAll('_', ' ')}
                  </Badge>
                  <span>
                    Updated{' '}
                    <time dateTime={task.updated_at}>
                      {dateFormat.format(new Date(task.updated_at))}
                    </time>
                  </span>
                  {currentTaskId === task.id && <span>Current task</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        !pending &&
        !error && (
          <p className={styles.empty}>
            No saved tasks yet. Your tasks will appear here when you start one.
          </p>
        )
      )}
      {pending && <p role="status">Loading saved tasks...</p>}
      {nextCursor && (
        <div>
          <Button size="small" disabled={pending} onClick={onLoadMore}>
            Load more tasks
          </Button>
        </div>
      )}
    </section>
  );
}
