import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ReductionPreviewView } from '../../../../app/contracts/damage-reduction-view.ts';
import { agentService } from '../../services/agents/index.ts';
import { useAgentRun, type AgentRun } from '../dashboard/useAgentRun.ts';
import { TaskControls } from '../chat/TaskControls.tsx';
import { TaskQuestions } from '../chat/TaskQuestions.tsx';
import { BackLink } from '../../shared/ui/BackLink.tsx';
import { Button, buttonClass } from '../../shared/ui/Button.tsx';
import { ReductionIntake } from './ReductionIntake.tsx';
import { ReductionResults } from './ReductionResults.tsx';
import { ProgrammeListPanel } from './ProgrammeViews.tsx';
import styles from './DamageReductionPage.module.css';

export function DamageReductionPage() {
  const { taskId } = useParams<{ taskId: string }>();
  return <ReductionWorkspace key={taskId ?? 'new'} taskId={taskId} />;
}

function ReductionWorkspace({ taskId }: { taskId?: string }) {
  const run = useAgentRun(taskId, 'haze.reduction.task.id', {
    restoreFromStorage: false,
  });
  const navigate = useNavigate();
  const [view, setView] = useState<ReductionPreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const record = run.task?.record;
  useEffect(() => {
    const recheck = () => setRefresh((value) => value + 1);
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }, []);
  useEffect(() => {
    if (!taskId && run.task?.id)
      void navigate(
        `/damage-reduction/tasks/${encodeURIComponent(run.task.id)}`,
        { replace: true },
      );
  }, [taskId, run.task?.id, navigate]);
  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController();
    setView(null);
    setError(null);
    if (!agentService.readReductionPreview) {
      setError(
        'The task service cannot read governed planning previews. Update the backend and retry.',
      );
      return;
    }
    agentService
      .readReductionPreview(taskId, controller.signal)
      .then((current) => {
        if (!controller.signal.aborted) setView(current);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'The saved preview is unavailable.',
          );
      });
    return () => controller.abort();
  }, [
    taskId,
    record?.updated_at,
    record?.state_revision,
    run.operationPending,
    refresh,
  ]);
  const matchingView =
    view &&
    (!record ||
      (view.run_id === record.current_run_id &&
        view.objective_revision === record.objective_revision))
      ? view
      : null;
  return (
    <DamageReductionView
      taskId={taskId}
      run={run}
      view={matchingView}
      viewError={error}
      onRefresh={() => setRefresh((value) => value + 1)}
    />
  );
}

export function DamageReductionView({
  taskId,
  run,
  view = null,
  viewError = null,
  onRefresh = () => {},
}: {
  taskId?: string;
  run: AgentRun;
  view?: ReductionPreviewView | null;
  viewError?: string | null;
  onRefresh?(): void;
}) {
  const navigate = useNavigate();
  const [savedId, setSavedId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const record = run.task?.record;
  const openSaved = (event: FormEvent) => {
    event.preventDefault();
    if (savedId.trim())
      void navigate(
        `/damage-reduction/tasks/${encodeURIComponent(savedId.trim())}`,
      );
  };
  const failure =
    error ??
    viewError ??
    run.operationError ??
    run.observationError ??
    record?.error?.message;
  return (
    <article className={styles.page}>
      <header className={styles.header}>
        <BackLink>Back to the dashboard</BackLink>
        <p className={styles.eyebrow}>Conditional planning preview</p>
        <h1>Damage reduction</h1>
        <p>
          Compare supplied physical damage estimates and prepare one digital
          intervention with explicit rules, prerequisites and independent
          review.
        </p>
        <p className={styles.note}>
          Predictions remain separate from delivery and achieved effects. This
          preview sends no alerts and changes no work schedules.
        </p>
        <Link to="/demos/damage-reduction">
          View the completed synthetic demo
        </Link>
      </header>
      <nav className={styles.steps} aria-label="Preview sections">
        <a href="#reduction-target-heading">1 Target</a>
        <a href="#reduction-assessment-heading">2 Assessment</a>
        <a href="#reduction-plan-heading">3 Conditional plan</a>
      </nav>
      {failure && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}
      {!taskId && <ProgrammeListPanel />}
      {!taskId ? (
        <section
          className={styles.card}
          aria-labelledby="new-reduction-heading"
        >
          <h2 id="new-reduction-heading">Create a preview</h2>
          <ReductionIntake run={run} onError={setError} />
        </section>
      ) : (
        <section className={styles.card} aria-label="Saved planning task">
          <div className={styles.actions}>
            <h2>Saved planning task</h2>
            <Link
              to="/damage-reduction"
              className={buttonClass('secondary', 'small')}
            >
              Create another preview
            </Link>
          </div>
          <p className={styles.identifier}>{taskId}</p>
          <p role="status">{run.statusText}</p>
          {record && (
            <>
              <p className={styles.note}>
                Task {record.status} · execution mode {record.mode} · objective
                revision {record.objective_revision}. Execution completion does
                not establish evidence support.
              </p>
              <TaskControls run={run} />
              <TaskQuestions run={run} />
              <div className={styles.actions}>
                <Link to={`/manager/${encodeURIComponent(taskId)}`}>
                  Open Manager workspace
                </Link>
                <Link to={`/task/${encodeURIComponent(taskId)}`}>
                  General task report
                </Link>
                <Button size="small" onClick={onRefresh}>
                  Recheck evidence and reviews
                </Button>
              </div>
            </>
          )}
        </section>
      )}
      {taskId &&
        (view ? (
          <ReductionResults view={view} />
        ) : (
          <div className={styles.results}>
            <section className={styles.card}>
              <h2 id="reduction-target-heading">1 Target</h2>
              <p>
                {failure
                  ? 'Evidence unavailable. Retry the governed saved-product read.'
                  : 'Loading exact saved target and sources…'}
              </p>
            </section>
            <section className={styles.card}>
              <h2 id="reduction-assessment-heading">2 Assessment</h2>
              <p>
                Server figures and current claim eligibility will appear here.
              </p>
            </section>
            <section className={styles.card}>
              <h2 id="reduction-plan-heading">3 Conditional plan</h2>
              <p>
                Review objections, prerequisites and conditional recommendations
                will appear here.
              </p>
            </section>
          </div>
        ))}
      {!taskId && (
        <div className={styles.results}>
          <section className={styles.card}>
            <h2 id="reduction-assessment-heading">2 Assessment</h2>
            <p>
              Exact supplied quantities and the independently checked target
              decision will appear after submission.
            </p>
          </section>
          <section className={styles.card}>
            <h2 id="reduction-plan-heading">3 Conditional plan</h2>
            <p>
              The reviewed plan will retain rule ownership, costs, subgroup
              constraints, objections and required next inputs.
            </p>
          </section>
        </div>
      )}
      <section className={styles.card} aria-labelledby="open-reduction-heading">
        <h2 id="open-reduction-heading">Open a saved preview</h2>
        <p className={styles.note}>
          The task URL contains its saved identifier; reopening does not require
          browser memory.
        </p>
        <form className={styles.openForm} onSubmit={openSaved}>
          <label htmlFor="reduction-saved-id">
            Task ID
            <input
              id="reduction-saved-id"
              value={savedId}
              onChange={(event) => setSavedId(event.target.value)}
              required
              placeholder="Paste the saved task ID"
            />
          </label>
          <Button type="submit" disabled={!savedId.trim()}>
            Open preview
          </Button>
        </form>
      </section>
    </article>
  );
}
