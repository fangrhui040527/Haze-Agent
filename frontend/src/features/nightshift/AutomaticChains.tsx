import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AutomaticReadiness } from '../../../../app/contracts/nightshift-automatic.ts';
import type { NightshiftChainAutomationView } from '../../../../app/contracts/nightshift-chains.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { NightshiftClient } from './jobsApi.ts';
import styles from './NightshiftPage.module.css';
import { ExternalWaitObserver } from './ExternalWaits.tsx';

export function AutomaticReleaseDetails({
  data,
}: {
  data: AutomaticReadiness | null;
}) {
  return (
    <section
      className={styles.panel}
      aria-label="Automatic chain release gates"
    >
      <h2>Automatic chain release</h2>
      <p>
        Automatic follow-ups are disabled by default. Only a new explicit
        admission can authorize a finite allowance; Resume cannot enable a
        manual-only chain.
      </p>
      {data ? (
        <>
          <p>
            Automatic execution:{' '}
            <strong>
              {data.ready && data.released
                ? 'available for explicit admission'
                : 'blocked'}
            </strong>
            . {data.reason}
          </p>
          {data.evidence_kind === 'fixture' ? (
            <p role="status">
              Fixture evidence proves control flow only. It does not establish
              production live readiness.
            </p>
          ) : null}
          <ul>
            {data.gates.map((gate) => (
              <li key={gate.id}>
                <strong>
                  {gate.label}: {gate.passed ? 'passed' : 'unmet'}
                </strong>
                {gate.reason ? ` — ${gate.reason}` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p role="status">
          Automatic mode is blocked while server release evidence is
          unavailable.
        </p>
      )}
      <p className={styles.note}>
        Haze server monitoring and eligible continuations run only while the
        server is running. This page installs no service and browser timers only
        observe saved state.
      </p>
    </section>
  );
}

/** Readback and user-authored progress are separate paths; polling never mutates. */
export function ChainAutomationObserver({
  chainId,
  originalRunId,
  observing,
  busy,
  closed,
  onPropose,
}: {
  chainId: string;
  originalRunId: string;
  observing: boolean;
  busy: boolean;
  closed: boolean;
  onPropose(progressText: string): void;
}) {
  const [client] = useState(() => new NightshiftClient());
  const [snapshot, setSnapshot] =
    useState<NightshiftChainAutomationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!observing) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const value = await client.chainAutomation(
          chainId,
          AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        );
        if (controller.signal.aborted) return;
        if (value.chain_id !== chainId)
          throw new Error('Chain readback target changed.');
        setSnapshot(value);
        setError(null);
      } catch {
        if (!controller.signal.aborted)
          setError(
            'Chain lineage and progress readback is unavailable. Saved records remain visible; refresh when the local server is available.',
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
  }, [client, chainId, observing, refresh]);
  const data = snapshot?.chain_id === chainId ? snapshot : null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onPropose(String(new FormData(event.currentTarget).get('progress')));
  };
  return (
    <section aria-label="Chain lineage and progress">
      {data ? (
        <ChainAutomationDetails data={data} originalRunId={originalRunId} />
      ) : (
        <p role="status">
          {observing
            ? 'Loading saved chain lineage...'
            : 'Browser observation stopped.'}
        </p>
      )}
      {data ? (
        <ExternalWaitObserver taskId={data.task_id} observing={observing} />
      ) : null}
      {error ? <p role="status">{error}</p> : null}
      <Button
        size="small"
        disabled={!observing}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh chain lineage
      </Button>
      {data?.automatic_enabled && data.progress ? (
        <form onSubmit={submit} key={data.progress.revision}>
          <h4>Propose a supported refinement</h4>
          <label>
            Versioned progress proposal
            <textarea
              name="progress"
              required
              maxLength={32768}
              rows={9}
              spellCheck={false}
              defaultValue={JSON.stringify(data.progress.progress, null, 2)}
            />
          </label>
          <p>
            A proposal must identify changed exact inputs, accepted outputs,
            review objections or a changed known failure cause. A new ID,
            revised prose, timer tick or higher judge score alone does not
            establish progress. This action cannot enlarge the grant or enable
            automatic mode.
          </p>
          <Button type="submit" disabled={busy || closed}>
            Submit revised progress
          </Button>
        </form>
      ) : null}
      <p className={styles.note}>
        {observing
          ? 'Observing saved chain state.'
          : 'Browser observation stopped.'}{' '}
        Reading lineage does not admit a successor or resubmit a job.
      </p>
    </section>
  );
}

export function ChainAutomationDetails({
  data,
  originalRunId,
}: {
  data: NightshiftChainAutomationView;
  originalRunId?: string;
}) {
  const initialRun =
    originalRunId ?? data.lineage[0]?.predecessor_run_id ?? data.current_run_id;
  const anchor = (runId: string) => `chain-${data.chain_id}-run-${runId}`;
  return (
    <>
      <h4>Lineage and cumulative authority</h4>
      {data.previous_chain_id ? (
        <p>
          Separately admitted grant linked to historical chain{' '}
          <code>{data.previous_chain_id}</code>. The old allowance remains
          closed.
          {data.previous_task_id ? (
            <>
              {' '}
              <Link to={`/task/${data.previous_task_id}`}>
                Previous granted task report
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      <p>
        <Link to={`/task/${data.task_id}`}>Owning task</Link> · Current run{' '}
        <a href={`#${anchor(data.current_run_id)}`}>
          <code>{data.current_run_id}</code>
        </a>
      </p>
      <dl className={styles.grant}>
        <div>
          <dt>Automatic mode</dt>
          <dd>
            {data.automatic_enabled ? 'Explicitly authorized' : 'Manual-only'}
          </dd>
        </div>
        <div>
          <dt>Admitted / maximum runs</dt>
          <dd>
            {data.admitted_runs} / {data.maximum_runs}
          </dd>
        </div>
        <div>
          <dt>Automatic follow-ups used / authorized</dt>
          <dd>
            {data.used_followups} / {data.authorized_followups}
          </dd>
        </div>
        <div>
          <dt>Automatic follow-ups remaining</dt>
          <dd>{data.remaining_followups}</dd>
        </div>
        <div>
          <dt>Original absolute expiry</dt>
          <dd>
            <time dateTime={data.original_expires_at}>
              {new Date(data.original_expires_at).toLocaleString()}
            </time>
          </dd>
        </div>
        <div>
          <dt>Next permitted purpose</dt>
          <dd>{data.next_purpose ?? 'None admitted'}</dd>
        </div>
        <div>
          <dt>Haze input bytes per model call</dt>
          <dd>{data.run_profile.max_model_input_bytes}</dd>
        </div>
        <div>
          <dt>Haze output tokens per model call</dt>
          <dd>{data.run_profile.max_model_output_tokens}</dd>
        </div>
        <div>
          <dt>Reserved synthesis and review model calls</dt>
          <dd>{data.run_profile.reserved_model_calls}</dd>
        </div>
      </dl>
      <div
        className={styles.tableWrap}
        tabIndex={0}
        role="region"
        aria-label="Chain run lineage table"
      >
        <table className={styles.table}>
          <caption>
            Run lineage — user Continue and automatic successors share the same
            total
          </caption>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Predecessor</th>
              <th scope="col">Admission actor / mode</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            <tr id={anchor(initialRun)}>
              <th scope="row">
                <code>{initialRun}</code>
              </th>
              <td>Initial enrolled run</td>
              <td>User / explicit admission</td>
              <td>Original limits, charges and deadline retained</td>
            </tr>
            {data.lineage.map((run) => (
              <tr key={run.run_id} id={anchor(run.run_id)}>
                <th scope="row">
                  <code>{run.run_id}</code>
                </th>
                <td>
                  <a href={`#${anchor(run.predecessor_run_id)}`}>
                    <code>{run.predecessor_run_id}</code>
                  </a>
                </td>
                <td>
                  {run.actor} / {run.mode}
                </td>
                <td>{run.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.progress ? (
        <>
          <p>
            Accepted progress revision {data.progress.revision} · actor{' '}
            {data.progress.actor} · last consumed result cursor{' '}
            {data.progress.progress.last_consumed_result_cursor}.
          </p>
          <p>
            Outstanding deliverables:{' '}
            {data.progress.progress.unresolved_deliverables.join('; ')}
          </p>
        </>
      ) : (
        <p>No automatic progress authority was admitted.</p>
      )}
      <h4>Retained inbox</h4>
      {data.inbox.length ? (
        <ul>
          {data.inbox.map((job) => (
            <li key={job.job_id}>
              <Link to={`/nightshift/${job.job_id}`}>
                <code>{job.job_id}</code>
              </Link>{' '}
              · {job.required ? 'Required' : 'Optional'} · {job.execution_state}{' '}
              · original run <code>{job.original_run_id}</code> ·{' '}
              {job.delivered_to_run_id ? (
                <>
                  assigned to run <code>{job.delivered_to_run_id}</code>
                </>
              ) : (
                'not assigned to a successor'
              )}
              {job.candidate ? (
                <span>
                  {' '}
                  · retained unreviewed reference{' '}
                  <code>
                    {job.candidate.id} v{job.candidate.version}{' '}
                    {job.candidate.sha256}
                  </code>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>No retained inbox deliveries.</p>
      )}
      <h4>Recorded stop decisions</h4>
      {data.stops.length ? (
        <ul>
          {data.stops.map((stop, index) => (
            <li key={`${stop.at}:${stop.cursor}:${index}`}>
              <strong>{stop.code}</strong>: {stop.message} · triggering cursor{' '}
              {stop.cursor}
              <pre>
                {JSON.stringify(
                  { references: stop.refs, remaining: stop.remaining },
                  null,
                  2,
                )}
              </pre>
            </li>
          ))}
        </ul>
      ) : (
        <p>No recorded stop decision.</p>
      )}
    </>
  );
}
