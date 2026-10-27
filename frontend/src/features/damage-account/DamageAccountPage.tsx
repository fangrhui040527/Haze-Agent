import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAgentRun, type AgentRun } from '../dashboard/useAgentRun.ts';
import { TaskQuestions } from '../chat/TaskQuestions.tsx';
import { Button, buttonClass } from '../../shared/ui/Button.tsx';
import { DamageWorkProducts } from './DamageWorkProducts.tsx';
import styles from './DamageAccountPage.module.css';
import { BackLink } from '../../shared/ui/BackLink.tsx';

const REQUEST_PREFIX = 'Build a damage account using World Model evidence. ';

/** This page owns its task selection; the dashboard keeps its existing session. */
export function DamageAccountPage() {
  const { taskId } = useParams<{ taskId: string }>();
  return <DamageAccountWorkspace key={taskId ?? 'new'} taskId={taskId} />;
}

function DamageAccountWorkspace({ taskId }: { taskId?: string }) {
  const run = useAgentRun(taskId, 'haze.damage.task.id');
  return <DamageAccountView taskId={taskId} run={run} />;
}

export function DamageAccountView({
  taskId,
  run,
}: {
  taskId?: string;
  run: AgentRun;
}) {
  const navigate = useNavigate();
  const [objective, setObjective] = useState('');
  const [savedId, setSavedId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const record = run.task?.record;
  const result = record?.result;
  const acquisitionGaps = [
    ...new Set(
      record?.assignments
        .filter(
          (assignment) =>
            assignment.definition_id === 'damage.collect' &&
            assignment.support === 'gap',
        )
        .flatMap((assignment) => assignment.gaps) ?? [],
    ),
  ];
  const active =
    !!record &&
    ['queued', 'running', 'waiting', 'paused'].includes(record.status);
  const observing = run.status === 'running';
  const baseUrl = run.task?.taskUrl.replace(/\/api\/tasks\/[^/]+$/, '') ?? '';
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      await run.ask({
        question: REQUEST_PREFIX + objective.trim(),
        focusItemId: null,
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The account could not be started.',
      );
    }
  };
  const openSaved = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = savedId.trim();
    if (id) navigate(`/damage-account/${encodeURIComponent(id)}`);
  };
  const receipts = run.events.flatMap((event) =>
    event.type === 'task_event' ? [event.receipt] : [],
  );
  return (
    <article className={styles.page}>
      <header className={styles.header}>
        <BackLink>Back to the dashboard</BackLink>
        <h1>Damage appraisal</h1>
        <p>
          Build and inspect accounts using evidence retained in World Model.
          Physical harm, financing and social welfare remain separate views.
        </p>
        <Link to="/demos/damage-account">
          View the completed synthetic demo
        </Link>
      </header>

      <div className={styles.intake}>
        {!taskId ? (
          <section aria-labelledby="new-account-heading">
            <h2 id="new-account-heading">Create an account</h2>
            <form
              className={styles.form}
              onSubmit={(event) => void submit(event)}
            >
              <p>
                Describe the location, episode and dates. The backend selects
                compatible World Model evidence and retains its exact sources.
                Missing evidence remains unestimated. No upload is required.
              </p>
              <label htmlFor="damage-objective">
                What should the account cover?
              </label>
              <textarea
                id="damage-objective"
                value={objective}
                placeholder="Build a damage account for Klang for 2025-09-01 to 2025-09-30."
                rows={4}
                maxLength={16000 - REQUEST_PREFIX.length}
                required
                disabled={active || observing}
                onChange={(event) => setObjective(event.target.value)}
              />
              <div className={styles.actions}>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    !objective.trim() ||
                    active ||
                    observing ||
                    run.operationPending
                  }
                >
                  Build account
                </Button>
              </div>
            </form>
          </section>
        ) : (
          <section className={styles.form}>
            <h2>Saved accounting task</h2>
            <p className={styles.identifier}>{taskId}</p>
            <Link to="/damage-account">Create another account</Link>
          </section>
        )}
        <section aria-labelledby="open-account-heading">
          <h2 id="open-account-heading">Open a saved task</h2>
          <form className={styles.form} onSubmit={openSaved}>
            <label htmlFor="damage-saved-task">Task ID</label>
            <input
              id="damage-saved-task"
              value={savedId}
              onChange={(event) => setSavedId(event.target.value)}
              placeholder="Paste a saved task ID"
              required
            />
            <div>
              <Button type="submit" disabled={!savedId.trim()}>
                Open account
              </Button>
            </div>
          </form>
          <p className={styles.note}>
            Retained evidence keeps its original applicability limits. An
            arithmetic review does not establish scientific attribution.
          </p>
        </section>
      </div>

      {(error ||
        run.observationError ||
        record?.error ||
        run.operationError) && (
        <p className={styles.error} role="alert">
          {error ??
            run.observationError ??
            record?.error?.message ??
            run.operationError}
        </p>
      )}
      {(record || taskId || observing) && (
        <section className={styles.section} aria-label="Accounting task status">
          <h2>
            {record
              ? `Task ${record.status}`
              : run.observationError || run.operationError
                ? 'Saved task unavailable'
                : 'Loading saved task'}
          </h2>
          <p role="status">{run.statusText}</p>
          {record && (
            <p className={styles.note}>
              Execution mode: {record.mode}. Objective revision{' '}
              {record.objective_revision}.
            </p>
          )}
          {observing && (
            <div>
              <Button size="small" variant="ghost" onClick={run.cancel}>
                Stop waiting
              </Button>
            </div>
          )}
          {record && (
            <>
              <TaskQuestions run={run} />
              <div className={styles.actions}>
                <Link
                  to={`/manager/${encodeURIComponent(record.id)}`}
                  className={buttonClass('secondary', 'small')}
                >
                  Open Manager workspace
                </Link>
              </div>
            </>
          )}
        </section>
      )}
      {acquisitionGaps.length > 0 && (
        <section
          className={styles.section}
          aria-labelledby="damage-evidence-gap-heading"
        >
          <h2 id="damage-evidence-gap-heading">Evidence needed</h2>
          <p>
            Account totals remain unestimated. Backend acquisition or scope
            clarification is required.
          </p>
          <ul>
            {acquisitionGaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </section>
      )}
      {result && (
        <section
          className={styles.section}
          aria-labelledby="account-results-heading"
        >
          <h2 id="account-results-heading">Account results</h2>
          <p>
            Review: {result.review.status.replaceAll('_', ' ')}.{' '}
            {result.currency === 'stale'
              ? 'Historical result; a correction requires a current account.'
              : 'Current saved result.'}
          </p>
          <DamageWorkProducts
            products={result.work_products}
            baseUrl={baseUrl}
            rejected={result.review.status === 'rejected'}
            reviewChecks={result.review.checks}
            stale={result.currency === 'stale'}
          />
          {!!result.review.checks?.length && (
            <details className={styles.details}>
              <summary>
                Independent review checks ({result.review.checks.length})
              </summary>
              <p>{result.review.scope}</p>
              <ul>
                {result.review.checks.map((check, index) => (
                  <li key={`${check.artifact.id}-${index}`}>
                    <a
                      href={`${baseUrl}/api/artifacts/${check.artifact.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Artifact version {check.artifact.version}
                    </a>
                    : {check.verdict.replaceAll('_', ' ')}.
                    <p className={styles.identifier}>
                      Producer revision {check.producer_revision}.{' '}
                      {check.reviewer_revision
                        ? `Reviewer revision ${check.reviewer_revision}.`
                        : 'Independent review pending.'}
                    </p>
                    {check.review_artifact && (
                      <a
                        href={`${baseUrl}/api/artifacts/${check.review_artifact.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open exact review
                      </a>
                    )}
                    {check.limitations.length > 0 && (
                      <ul>
                        {check.limitations.map((limitation, item) => (
                          <li key={item}>{limitation}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details className={styles.details}>
            <summary>Answer and remaining requirements</summary>
            <p className={styles.answer}>{result.answer}</p>
            {result.uncertainty.length > 0 && (
              <ul>
                {result.uncertainty.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            )}
            {result.next_requirements.length > 0 && (
              <>
                <h3>What is needed next</h3>
                <ul>
                  {result.next_requirements.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </>
            )}
          </details>
        </section>
      )}
      {record && (
        <details className={styles.details}>
          <summary>
            Task coordination and execution receipts ({receipts.length})
          </summary>
          <ol>
            {receipts.map((receipt) => (
              <li key={receipt.cursor}>
                <strong>{receipt.actor}</strong>: {receipt.message}
              </li>
            ))}
          </ol>
          <Link to={`/task/${encodeURIComponent(record.id)}`}>
            Open the general task report
          </Link>
        </details>
      )}
      {!result && !record && !taskId && (
        <p className={styles.note}>
          Saved accounting results will appear here after a task completes. The
          dashboard keeps its own task and office.
        </p>
      )}
    </article>
  );
}
