import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ExternalWaitView } from '../../../../app/contracts/external-waits.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { NightshiftClient } from './jobsApi.ts';
import styles from './NightshiftPage.module.css';

const reasonLabel = {
  compute: 'Waiting for external compute',
  capacity: 'Waiting for Haze capacity',
  human: 'Waiting for a user',
  stopped: 'Stopped work',
} as const;

/** Anything here the user could still be waiting on; a stopped, empty view is not. */
export function hasPendingExternalWork(data: ExternalWaitView): boolean {
  const reason = data.capacity.wait_reason;
  return (
    reason === 'compute' ||
    reason === 'capacity' ||
    data.capacity.queue !== null ||
    data.waits.length > 0 ||
    data.deliveries.length > 0
  );
}

/** This observer has no mutation path; stored authority remains on the server. */
export function ExternalWaitObserver({
  taskId,
  jobId,
  observing = true,
  compact = false,
}: {
  taskId: string;
  jobId?: string;
  observing?: boolean;
  /** Task report: render only while external work is pending, without operator detail. */
  compact?: boolean;
}) {
  const [client] = useState(() => new NightshiftClient());
  const [snapshot, setSnapshot] = useState<ExternalWaitView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [watching, setWatching] = useState(true);
  const active = observing && watching;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const data = await client.externalWaits(
          taskId,
          AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        );
        if (controller.signal.aborted) return;
        if (data.task_id !== taskId)
          throw new Error('The wait view does not match this task.');
        setSnapshot(data);
        setError(null);
      } catch {
        if (!controller.signal.aborted)
          setError(
            'Wait and capacity readback is unavailable. Retained state remains visible; refresh when the local server is available.',
          );
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void load(), 2000);
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, taskId, active, refresh]);
  const data = snapshot?.task_id === taskId ? snapshot : null;
  if (compact) {
    if (!data || !hasPendingExternalWork(data)) return null;
    return (
      <section className={styles.panel} aria-label="External waits">
        <h2>Waiting on external work</h2>
        <ExternalWaitDetails data={data} jobId={jobId} compact />
      </section>
    );
  }
  return (
    <section className={styles.panel} aria-label="External waits and capacity">
      <h2>External waits and Haze capacity</h2>
      {data ? (
        <ExternalWaitDetails data={data} jobId={jobId} />
      ) : (
        <p role="status">
          {active
            ? 'Loading saved wait and capacity records...'
            : 'Browser observation stopped.'}
        </p>
      )}
      {error ? <p role="status">{error}</p> : null}
      <p className={styles.note}>
        {active
          ? 'Observing saved wait state.'
          : 'Browser observation stopped.'}{' '}
        Observation does not cancel a job, close a chain or start a run.
      </p>
      <div className={styles.actions}>
        <Button
          size="small"
          disabled={!observing}
          onClick={() => setWatching((value) => !value)}
        >
          {watching ? 'Stop wait observation' : 'Resume wait observation'}
        </Button>
        <Button
          size="small"
          disabled={!active}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh wait state
        </Button>
      </div>
    </section>
  );
}

/** A released permit and a public waiting status describe different facts. */
export function ExternalWaitDetails({
  data,
  jobId,
  compact = false,
}: {
  data: ExternalWaitView;
  jobId?: string;
  compact?: boolean;
}) {
  const waits = jobId
    ? data.waits.filter((wait) =>
        wait.dependencies.some((dependency) => dependency.job_id === jobId),
      )
    : data.waits;
  const deliveries = jobId
    ? data.deliveries.filter((delivery) => delivery.job_id === jobId)
    : data.deliveries;
  const capacity = data.capacity;
  return (
    <>
      {!compact && (
        <p>
          <Link to={`/task/${encodeURIComponent(data.task_id)}`}>
            Owning task
          </Link>{' '}
          <code>{data.task_id}</code>
        </p>
      )}
      <p role="status">
        <strong>
          {capacity.wait_reason
            ? reasonLabel[capacity.wait_reason]
            : 'No external wait reason recorded'}
        </strong>
        {' · '}Task permit: {capacity.permit}.
      </p>
      {!compact && (
        <p>
          Haze allows two task permits and two shared specialist slots. Remote
          job reservations are counted separately.
        </p>
      )}
      {capacity.queue ? (
        <p>
          Capacity queue: {capacity.queue.status}; first eligible sequence{' '}
          {capacity.queue.sequence}. Target thread{' '}
          <code>{capacity.queue.thread_id}</code>.
          {capacity.queue.reason ? (
            <> Reason: {capacity.queue.reason}.</>
          ) : null}
        </p>
      ) : compact ? null : (
        <p>No capacity queue entry is recorded.</p>
      )}
      {capacity.wait_reason === 'stopped' ? (
        <p>
          Check the task and chain stop reasons before using task controls. An
          expired run requires explicit Continue within the same remaining
          grant.
        </p>
      ) : null}
      {compact && !waits.length ? null : (
        <h3>Required dependencies and target revisions</h3>
      )}
      {waits.length ? (
        <ol className={styles.events}>
          {waits.map((wait) => (
            <li key={wait.id}>
              <p>
                <strong>Wait {wait.state}</strong>
                {wait.reason ? `: ${wait.reason}` : ''}
              </p>
              <p>
                Run <code>{wait.authority.run_id}</code>; generation{' '}
                {wait.authority.generation}; objective revision{' '}
                {wait.authority.objective_revision}; assignment{' '}
                <code>{wait.authority.assignment_id}</code> revision{' '}
                {wait.authority.assignment_revision}.
              </p>
              <p>
                Event cursor {wait.after_cursor}; thread{' '}
                <code>{wait.thread_id}</code>.
              </p>
              <ul>
                {wait.dependencies.map((dependency) => (
                  <li key={dependency.job_id}>
                    <Link
                      to={`/nightshift/${encodeURIComponent(dependency.job_id)}`}
                    >
                      {dependency.job_id}
                    </Link>{' '}
                    —{' '}
                    {dependency.required
                      ? 'Required result; blocks finalization while pending'
                      : 'Optional result'}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      ) : compact ? null : (
        <p>
          No external dependencies are recorded{jobId ? ' for this job' : ''}.
        </p>
      )}
      {compact && !deliveries.length ? null : (
        <h3>Retained result deliveries</h3>
      )}
      {deliveries.length ? (
        <ol className={styles.events}>
          {deliveries.map((delivery) => (
            <li key={delivery.id}>
              <Link to={`/nightshift/${encodeURIComponent(delivery.job_id)}`}>
                Job {delivery.job_id}
              </Link>
              <p>
                Remote result: {delivery.execution_state}. Delivery:{' '}
                {delivery.state}; event cursor {delivery.event_cursor}.
              </p>
              {delivery.reason ? <p>Stop reason: {delivery.reason}</p> : null}
              {delivery.artifact ? (
                <p>
                  Retained output reference: <code>{delivery.artifact.id}</code>
                  , version {delivery.artifact.version}, SHA-256{' '}
                  <code>{delivery.artifact.sha256}</code>.
                </p>
              ) : (
                <p>No candidate output reference was retained.</p>
              )}
              {['failed', 'cancelled', 'rejected'].includes(
                delivery.execution_state,
              ) ? (
                <p>
                  A required failed result needs an explicit failure,
                  partial-result or replanning decision.
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : compact ? null : (
        <p>
          No terminal result delivery is recorded. Remote progress and receipt
          retrieval remain visible on each job.
        </p>
      )}
      {!compact && (
        <p className={styles.note}>
          Retained bytes do not grant execution authority or establish evidence
          acceptance. Current permissions, exact references and independent
          review still apply.
        </p>
      )}
    </>
  );
}
