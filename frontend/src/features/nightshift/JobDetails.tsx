import { useState } from 'react';
import { Link } from 'react-router';
import type {
  NightshiftChain,
  NightshiftJob,
  NightshiftEventPage,
} from '../../../../app/contracts/nightshift-records.ts';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './NightshiftPage.module.css';
import { ChainAutomationObserver } from './AutomaticChains.tsx';

export function ChainSummary({
  chain,
  busy,
  onControl,
  observing = true,
  onPropose,
}: {
  chain: NightshiftChain;
  busy: boolean;
  onControl(action: 'pause' | 'resume' | 'cancel' | 'close'): void;
  observing?: boolean;
  onPropose?: (progressText: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const automatic =
    chain.schema_version === 'haze.nightshift.chain.v2' &&
    chain.grant.automatic_followup_runs > 0;
  const closed = ['closed', 'expired', 'invalidated'].includes(chain.status);
  return (
    <article className={styles.panel} id={`chain-${chain.id}`}>
      <h3>
        {automatic ? 'Opt-in automatic' : 'Manual-only'} chain{' '}
        <code>{chain.id}</code>
      </h3>
      <p>
        Status: <strong>{chain.status}</strong> · revision {chain.revision} ·{' '}
        <Link to={`/task/${chain.task_id}`}>Task report</Link> ·{' '}
        <Link to={`/manager/${chain.task_id}`}>Manager workspace</Link>
      </p>
      <p>
        Absolute expiry:{' '}
        <time dateTime={chain.expires_at}>
          {new Date(chain.expires_at).toLocaleString()}
        </time>
        . Authorized automatic follow-ups: {chain.grant.automatic_followup_runs}
        .{' '}
        {chain.grant.privacy === 'cloud-ok'
          ? 'Cloud allowed / No cloud spend cap.'
          : 'Local only / $0 cloud spend.'}
      </p>
      <dl className={styles.grant}>
        <div>
          <dt>Runs remaining</dt>
          <dd>
            {chain.remaining.runs} / {chain.grant.total_runs}
          </dd>
        </div>
        <div>
          <dt>Admitted runs</dt>
          <dd>
            {chain.usage.runs} / {chain.grant.total_runs}
          </dd>
        </div>
        <div>
          <dt>Jobs remaining</dt>
          <dd>
            {chain.remaining.jobs} / {chain.grant.max_jobs}
          </dd>
        </div>
        <div>
          <dt>Requested attempts remaining</dt>
          <dd>
            {chain.remaining.requested_attempts} / {chain.grant.max_attempts}
          </dd>
        </div>
        <div>
          <dt>Haze model calls remaining</dt>
          <dd>
            {chain.remaining.model_calls} / {chain.grant.max_model_calls}
          </dd>
        </div>
        <div>
          <dt>Tool calls remaining</dt>
          <dd>
            {chain.remaining.tool_calls} / {chain.grant.max_tool_calls}
          </dd>
        </div>
        <div>
          <dt>Assignments remaining</dt>
          <dd>
            {chain.remaining.assignments} / {chain.grant.max_assignments}
          </dd>
        </div>
        <div>
          <dt>Artifacts remaining</dt>
          <dd>
            {chain.remaining.artifacts} / {chain.grant.max_artifacts}
          </dd>
        </div>
        <div>
          <dt>Receipt retention reserved</dt>
          <dd>{chain.usage.retention_reserved}</dd>
        </div>
      </dl>
      <p>
        Job spend policy:{' '}
        {chain.grant.privacy === 'cloud-ok'
          ? 'cloud allowed, no cloud spend cap.'
          : 'local only, $0 cloud spend.'}{' '}
        Normal Haze agent calls use separate model routes and call/token limits.
      </p>
      {chain.stop_reason ? (
        <p role="status">Stop reason: {chain.stop_reason}</p>
      ) : null}
      <div className={styles.actions}>
        <Button
          disabled={busy || closed || chain.status !== 'active'}
          onClick={() => onControl('pause')}
        >
          Pause new submissions
        </Button>
        <Button
          disabled={busy || closed || chain.status !== 'paused'}
          onClick={() => onControl('resume')}
        >
          Resume original grant
        </Button>
        <Button disabled={busy || closed} onClick={() => onControl('close')}>
          Close chain
        </Button>
        <Button
          variant="danger"
          disabled={busy || closed}
          onClick={() => onControl('cancel')}
        >
          Cancel chain and request job cancellation
        </Button>
      </div>
      <p className={styles.note}>
        Closing authority does not erase reservations or historical receipts.
        Known jobs remain observable after pause, correction, expiry or
        cancellation.
      </p>
      <p className={styles.note}>
        Pausing a chain also pauses its current result consumers. Resuming the
        original grant leaves the task paused; use Resume in the{' '}
        <Link to={`/task/${chain.task_id}`}>task controls</Link> to request Haze
        capacity within the original deadline. If that run expired, explicitly
        Continue after restoring the original chain grant. A paused grant
        freezes manual and automatic continuation alike.
      </p>
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>Inspect lineage, inbox and progress decisions</summary>
        {expanded ? (
          <ChainAutomationObserver
            chainId={chain.id}
            originalRunId={chain.original_run_id}
            observing={observing}
            busy={busy || !onPropose}
            closed={closed}
            onPropose={(text) => onPropose?.(text)}
          />
        ) : null}
      </details>
    </article>
  );
}

export function JobDetails({
  job,
  events,
  busy,
  canReconcile,
  onCancel,
  onReconcile,
  onSelect,
}: {
  job: NightshiftJob;
  events: NightshiftEventPage['events'];
  busy: boolean;
  canReconcile: boolean;
  onCancel(): void;
  onReconcile(remoteId: string): void;
  onSelect(assignmentId: string): void;
}) {
  return (
    <article className={styles.panel}>
      <h2>
        Job <code>{job.id}</code>
      </h2>
      <p>
        <strong>Unreviewed candidate</strong> · execution: {job.execution_state}{' '}
        · judge outcome: {job.judge_outcome.status} · receipt:{' '}
        {job.receipt ? 'retained' : 'not available'}
      </p>
      <p>
        Progress: {job.progress.generated ?? 'unknown'} /{' '}
        {job.progress.requested_attempts ?? job.options.n} attempts. Remote
        handle: <code>{job.remote_id ?? 'not acknowledged'}</code>.
      </p>
      <p>
        Candidate compute policy:{' '}
        {job.options.privacy === 'cloud-ok'
          ? 'Cloud allowed · No cloud spend cap.'
          : 'Local only · $0 cloud spend.'}
      </p>
      <p>
        <Link to={`/task/${job.task_id}`}>Originating task</Link> · chain{' '}
        <code>{job.chain_id}</code>. The remote judge cannot approve Haze
        evidence or replace an independent EvidenceCritic review.
      </p>
      <dl className={styles.grant}>
        <div>
          <dt>Original run</dt>
          <dd>
            <code>{job.authority.run_id}</code>
          </dd>
        </div>
        <div>
          <dt>Original generation / objective revision</dt>
          <dd>
            {job.authority.generation} / {job.authority.objective_revision}
          </dd>
        </div>
        <div>
          <dt>Original assignment / revision</dt>
          <dd>
            {job.authority.assignment_id ?? 'task submission'} /{' '}
            {job.authority.assignment_revision ?? 'not applicable'}
          </dd>
        </div>
        <div>
          <dt>Admitted route</dt>
          <dd>
            <code>{job.route_id}</code>
          </dd>
        </div>
        <div>
          <dt>Adapter / runtime</dt>
          <dd>
            {job.adapter_version} / {job.runtime_version ?? 'unknown'}
          </dd>
        </div>
        <div>
          <dt>Cancellation requested</dt>
          <dd>{job.cancellation.requested ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Cancellation acknowledged</dt>
          <dd>{job.cancellation.acknowledged ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Remote termination confirmed</dt>
          <dd>
            {job.cancellation.remote_termination_confirmed ? 'Yes' : 'No'}
          </dd>
        </div>
      </dl>
      <p>
        Cancellation acknowledgement alone does not establish that remote
        compute stopped or release its capacity reservation.
      </p>
      {!job.cancellation.remote_termination_confirmed &&
      ['completed', 'failed', 'cancelled'].includes(job.execution_state) ? (
        <p role="status">
          The runtime reports {job.execution_state}, but remote termination
          remains unconfirmed. Compute capacity remains reserved and server
          observation continues.
        </p>
      ) : null}
      {job.retrieval_error ? (
        <p role="alert">Unresolved receipt: {job.retrieval_error.message}</p>
      ) : null}
      {job.remote_diagnostic ? (
        <section aria-label="Retained remote execution diagnostic">
          <h3>Remote execution diagnostic</h3>
          <p>
            Reported execution state:{' '}
            <code>{job.remote_diagnostic.execution_state ?? 'unknown'}</code>.
          </p>
          <p>
            Failure code:{' '}
            <code>{job.remote_diagnostic.failure_code ?? 'unknown'}</code>.
          </p>
          {job.remote_diagnostic.failure_code ===
          'privacy_floor_refuses_pinned_model' ? (
            <p>
              The runtime refused the pinned model under the local-only policy.
              Configure a compatible local lane or fleet in Nightshift before
              submitting new work.
            </p>
          ) : null}
          <p className={styles.note}>
            This diagnostic belongs to the retained remote observation. Receipt
            retrieval is reported separately.
          </p>
        </section>
      ) : null}
      {job.execution_state === 'submission_unknown' ? (
        <p role="alert">
          Submission outcome is unknown. Its capacity and requested attempts
          remain reserved. It will not be automatically resubmitted.
        </p>
      ) : null}
      {job.read_failures ? (
        <p>
          Read failures: {job.read_failures}. Next server observation:{' '}
          {job.next_poll_at ?? 'unresolved'}.
        </p>
      ) : null}
      <Button
        variant="danger"
        disabled={
          busy ||
          job.cancellation.requested ||
          job.cancellation.remote_termination_confirmed ||
          job.execution_state === 'rejected'
        }
        onClick={onCancel}
      >
        Request cancellation of this job
      </Button>
      <details>
        <summary>Original brief and exact input references</summary>
        <pre className={styles.output}>{job.prompt}</pre>
        <ul>
          {job.input_refs.map((ref) => (
            <li key={`${ref.id}:${ref.version}:${ref.sha256}`}>
              <code>
                {ref.id} · version {ref.version} · SHA-256 {ref.sha256}
              </code>
            </li>
          ))}
        </ul>
        {job.input_refs.length === 0 ? (
          <p>No input artifact references were supplied.</p>
        ) : null}
        <p>
          Request fingerprint: <code>{job.request_fingerprint}</code>
        </p>
        <p>
          Installed schema hash: <code>{job.schema_hash}</code>
        </p>
      </details>
      <details>
        <summary>Judge outcome</summary>
        <p>Basis: {job.judge_outcome.basis ?? 'unknown'}</p>
        <p>{job.judge_outcome.explanation ?? 'No explanation was retained.'}</p>
      </details>
      {job.receipt ? (
        <section aria-label="Retained candidate output">
          <h3>Historical candidate output</h3>
          <p>
            Service-produced derived material, captured{' '}
            <time dateTime={job.receipt.captured_at}>
              {job.receipt.captured_at}
            </time>
            . Review status: {job.review_status}.
          </p>
          <pre className={styles.output}>{job.receipt.output}</pre>
          <p>
            Artifact:{' '}
            <code>
              {job.receipt.artifact.id} · version {job.receipt.artifact.version}{' '}
              · SHA-256 {job.receipt.artifact.sha256}
            </code>
          </p>
          <details>
            <summary>
              Actual attempt metadata ({job.receipt.attempts.length})
            </summary>
            <pre className={styles.output}>
              {JSON.stringify(job.receipt.attempts, null, 2)}
            </pre>
            <p>Missing model, lane and usage metadata remains unknown.</p>
          </details>
          <form
            className={styles.inlineForm}
            onSubmit={(event) => {
              event.preventDefault();
              onSelect(
                String(
                  new FormData(event.currentTarget).get('assignment_id'),
                ).trim(),
              );
            }}
          >
            <h3>Explicitly select this candidate</h3>
            <p>
              Selection creates an exact dependency for the current authorized
              work. It does not mark the candidate applicable, accepted or
              independently reviewed. Current revisions, grant, deadline and
              inputs are revalidated.
            </p>
            <label>
              Current target assignment ID (optional)
              <input
                name="assignment_id"
                maxLength={36}
                placeholder="Leave empty for task dependency"
              />
            </label>
            <Button type="submit" disabled={busy}>
              Select candidate for current work
            </Button>
          </form>
          <p>
            Selection records: {job.selections.length}. Every selection still
            requires independent review.
          </p>
        </section>
      ) : null}
      {job.execution_state === 'submission_unknown' ? (
        <form
          className={styles.inlineForm}
          onSubmit={(event) => {
            event.preventDefault();
            onReconcile(
              String(new FormData(event.currentTarget).get('remote_id')).trim(),
            );
          }}
        >
          <h3>Reconcile an unknown submission</h3>
          <p>
            {canReconcile
              ? 'Only a verified remote request and ownership match may reconcile this handle.'
              : 'The installed runtime cannot prove request ownership for reconciliation. Blind attachment by prompt or timestamp is unavailable.'}
          </p>
          <label>
            Verified remote job ID
            <input
              name="remote_id"
              required
              maxLength={160}
              disabled={!canReconcile}
            />
          </label>
          <Button type="submit" disabled={busy || !canReconcile}>
            Reconcile verified job
          </Button>
        </form>
      ) : null}
      <section aria-label="Persisted progress events">
        <h3>Persisted progress</h3>
        <ol className={styles.events}>
          {events.map((event) => (
            <li key={event.cursor}>
              <time dateTime={event.at}>
                {new Date(event.at).toLocaleString()}
              </time>{' '}
              · cursor {event.cursor} · {event.type}: {event.message}
            </li>
          ))}
        </ol>
        {events.length === 0 ? (
          <p>No retained progress events were read.</p>
        ) : null}
      </section>
    </article>
  );
}
