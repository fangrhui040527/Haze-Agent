import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { z } from 'zod';
import {
  reductionProgrammeListSchema,
  type ReductionProgrammeAttemptView,
  type ReductionProgrammeCapacity,
  type ReductionProgrammePhase,
  type ReductionProgrammeView,
} from '../../../../app/contracts/damage-reduction-programme.ts';
import { Button, buttonClass } from '../../shared/ui/Button.tsx';
import { Badge } from '../../shared/ui/Badge.tsx';
import { ExactSource, ReductionResults } from './ReductionResults.tsx';
import { reductionProgrammeClient } from './programme-api.ts';
import styles from './DamageReductionPage.module.css';
import { PilotTaskResults } from './PilotResults.tsx';
import { EvaluationTaskResults } from './EvaluationResults.tsx';

export function ProgrammeListPanel({
  currentId,
  currentRevision,
}: {
  currentId?: string;
  currentRevision?: number;
}) {
  const [page, setPage] = useState<z.infer<
    typeof reductionProgrammeListSchema
  > | null>(null);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setPending(true);
    setError(null);
    reductionProgrammeClient
      .list(offset, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Programme selection is unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
  }, [currentId, currentRevision, offset, refresh]);
  return (
    <section
      className={styles.card}
      aria-labelledby="programme-selection-heading"
    >
      <div className={styles.actions}>
        <h2 id="programme-selection-heading">Saved programmes</h2>
        <Link
          to="/damage-reduction/programmes/new"
          className={buttonClass('secondary', 'small')}
        >
          Create programme
        </Link>
        <Button
          size="small"
          onClick={() => setRefresh((value) => value + 1)}
          disabled={pending}
        >
          Refresh programmes
        </Button>
      </div>
      <p className={styles.note}>
        A programme coordinates explicitly started bounded tasks. Standalone
        planning previews remain available below. No programme phase starts
        automatically.
      </p>
      {pending && <p role="status">Loading programme selection…</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {page && <ProgrammeListView page={page} currentId={currentId} />}
      <div className={styles.actions}>
        {offset > 0 && (
          <Button size="small" disabled={pending} onClick={() => setOffset(0)}>
            Newest programmes
          </Button>
        )}
        {page?.next_offset !== null && page?.next_offset !== undefined && (
          <Button
            size="small"
            disabled={pending}
            onClick={() => setOffset(page.next_offset!)}
          >
            More programmes
          </Button>
        )}
      </div>
    </section>
  );
}

export function ProgrammeListView({
  page,
  currentId,
}: {
  page: z.infer<typeof reductionProgrammeListSchema>;
  currentId?: string;
}) {
  if (!page.programmes.length)
    return (
      <p>No programmes are saved in this local workspace and execution mode.</p>
    );
  return (
    <ul>
      {page.programmes.map((programme) => (
        <li key={programme.id}>
          <Link
            to={`/damage-reduction/programmes/${encodeURIComponent(programme.id)}`}
            aria-current={currentId === programme.id ? 'page' : undefined}
          >
            {programme.title}
          </Link>
          <span className={styles.note}>
            {' '}
            — revision {programme.revision}, {programme.mode}; accountable owner{' '}
            {programme.accountable_owner}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ProgrammeCapacity({
  capacity,
}: {
  capacity: ReductionProgrammeCapacity;
}) {
  return (
    <section
      className={styles.card}
      aria-labelledby="programme-capacity-heading"
    >
      <h2 id="programme-capacity-heading">Remaining capacity</h2>
      <p className={styles.note}>
        Server-calculated capacity is revalidated before admission. Unknown
        remote attempts stay charged; only unused terminal reservations are
        released.
      </p>
      <dl className={styles.facts}>
        <div>
          <dt>Model calls remaining</dt>
          <dd>
            {capacity.remaining_model_calls} · charged{' '}
            {capacity.charged_model_calls} · reserved{' '}
            {capacity.reserved_model_calls}
          </dd>
        </div>
        <div>
          <dt>Tool calls remaining</dt>
          <dd>
            {capacity.remaining_tool_calls} · charged{' '}
            {capacity.charged_tool_calls} · reserved{' '}
            {capacity.reserved_tool_calls}
          </dd>
        </div>
        <div>
          <dt>Runs remaining</dt>
          <dd>{capacity.remaining_runs}</dd>
        </div>
        <div>
          <dt>Attempts remaining</dt>
          <dd>
            Assessment {capacity.remaining_attempts.assessment} · planning{' '}
            {capacity.remaining_attempts.planning}
            {' · pilot '}
            {capacity.remaining_attempts.pilot ?? 'unavailable'}
            {' · evaluation '}
            {capacity.remaining_attempts.evaluation ?? 'unavailable'}
          </dd>
        </div>
      </dl>
      {capacity.active_attempt_id && (
        <p role="status">
          One phase is active. Further starts wait for its terminal outcome.
        </p>
      )}
    </section>
  );
}

export function canRequestProgrammePhase(
  view: ReductionProgrammeView,
  phase: ReductionProgrammePhase,
  pending = false,
): boolean {
  return (
    !pending &&
    !view.capacity.active_attempt_id &&
    view.capacity.remaining_runs > 0 &&
    (view.capacity.remaining_attempts[phase] ?? 0) > 0 &&
    view.capacity.remaining_model_calls > 0 &&
    view.capacity.remaining_tool_calls > 0
  );
}

export function ProgrammeAttempts({
  attempts,
}: {
  attempts: ReductionProgrammeAttemptView[];
}) {
  if (!attempts.length)
    return (
      <p>
        No phase has been admitted. Choose an explicit start above when the
        inputs and remaining capacity are ready.
      </p>
    );
  return (
    <div className={styles.results}>
      {attempts.map((entry) => (
        <ProgrammeAttempt key={entry.attempt.id} entry={entry} />
      ))}
    </div>
  );
}

export function ProgrammeAttempt({
  entry,
}: {
  entry: ReductionProgrammeAttemptView;
}) {
  const { attempt } = entry;
  const preview =
    entry.preview && entry.currency !== 'current'
      ? {
          ...entry.preview,
          state: 'stale' as const,
          plan_eligibility: 'none' as const,
          claims: null,
        }
      : entry.preview;
  return (
    <section
      className={styles.card}
      aria-label={`${attempt.phase} attempt ${attempt.id}`}
    >
      <div className={styles.actions}>
        <h3>
          {attempt.phase.charAt(0).toUpperCase() + attempt.phase.slice(1)}{' '}
          attempt
        </h3>
        <Badge tone={entry.currency === 'current' ? 'info' : 'stale'}>
          {entry.currency}
        </Badge>
        <Badge
          tone={
            entry.result_status === 'gap' ||
            entry.result_status === 'unavailable'
              ? 'warn'
              : 'neutral'
          }
        >
          {entry.result_status.replaceAll('_', ' ')}
        </Badge>
      </div>
      <p>
        Execution: {entry.execution_status.replaceAll('_', ' ')}. Bound
        programme revision {attempt.programme_revision}; objective revision{' '}
        {attempt.objective_revision}.
      </p>
      <dl className={styles.facts}>
        <div>
          <dt>Exact task</dt>
          <dd className={styles.identifier}>{attempt.task_id}</dd>
        </div>
        <div>
          <dt>Exact linked run</dt>
          <dd className={styles.identifier}>{attempt.run_id}</dd>
        </div>
        <div>
          <dt>Relevant-input fingerprint</dt>
          <dd className={styles.identifier}>{attempt.input_fingerprint}</dd>
        </div>
        <div>
          <dt>Admitted reservation</dt>
          <dd>
            {attempt.reservation.model_calls} model calls ·{' '}
            {attempt.reservation.tool_calls} tool calls
          </dd>
        </div>
      </dl>
      <div className={styles.actions}>
        <Link
          to={`/damage-reduction/tasks/${encodeURIComponent(attempt.task_id)}`}
        >
          Open task workspace
        </Link>
        <Link to={`/manager/${encodeURIComponent(attempt.task_id)}`}>
          Task controls and Manager
        </Link>
      </div>
      <p className={styles.note}>
        Programme status above belongs to the exact linked run. A task workspace
        can contain later runs; it does not silently replace this binding.
      </p>
      {entry.reasons.length > 0 && (
        <ul>
          {entry.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}
      {attempt.assessment_attempt_id && (
        <p className={styles.identifier}>
          Bound assessment attempt: {attempt.assessment_attempt_id}
        </p>
      )}
      {attempt.planning_attempt_id && (
        <p className={styles.identifier}>
          Bound planning attempt: {attempt.planning_attempt_id}
        </p>
      )}
      {entry.pilot && (
        <details>
          <summary>
            Inspect retained pilot feasibility, protocol and review
          </summary>
          <PilotTaskResults
            view={
              entry.currency === 'current'
                ? entry.pilot
                : { ...entry.pilot, state: 'stale' }
            }
            idPrefix={`programme-attempt-${attempt.id}-pilot`}
          />
        </details>
      )}
      {preview && (
        <details>
          <summary>Inspect retained assessment and conditional plan</summary>
          <ReductionResults
            view={preview}
            idPrefix={`programme-attempt-${attempt.id}`}
          />
        </details>
      )}
      {attempt.registration_id && (
        <p className={styles.identifier}>
          Bound evaluation registration: {attempt.registration_id}
        </p>
      )}
      {entry.evaluation && (
        <details>
          <summary>
            Inspect retained external evaluation, technical review and lessons
          </summary>
          <EvaluationTaskResults
            view={
              entry.currency === 'current'
                ? entry.evaluation
                : { ...entry.evaluation, state: 'historical' }
            }
            idPrefix={`programme-attempt-${attempt.id}-evaluation`}
          />
        </details>
      )}
      {!!entry.historical_artifact_refs.length && (
        <details>
          <summary>
            Historical exact artifact references (
            {entry.historical_artifact_refs.length})
          </summary>
          <p className={styles.note}>
            Historical artifacts do not establish a current programme result.
          </p>
          {entry.historical_artifact_refs.map((reference, index) => (
            <ExactSource
              key={`${reference.id}:${reference.version}:${reference.sha256}`}
              reference={reference}
              label={`Historical artifact ${index + 1}`}
            />
          ))}
        </details>
      )}
    </section>
  );
}
