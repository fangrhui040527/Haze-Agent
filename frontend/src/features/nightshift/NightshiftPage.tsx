import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ModelReadiness } from '../../../../app/contracts/model-routes.ts';
import type { TaskRecord } from '../../../../app/contracts/tasks.ts';
import type { NightshiftJobReadiness } from '../../../../app/contracts/nightshift.ts';
import type { AutomaticReadiness } from '../../../../app/contracts/nightshift-automatic.ts';
import type {
  NightshiftChain,
  NightshiftJob,
  NightshiftEventPage,
} from '../../../../app/contracts/nightshift-records.ts';
import {
  summarizeNightshiftJob,
  type NightshiftJobSummary,
} from '../../../../app/contracts/nightshift-list.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { StateMessage } from '../../shared/ui/States.tsx';
import { fetchModelReadiness } from './readinessApi.ts';
import {
  NightshiftClient,
  MutationIntent,
  canReconcileNightshiftJob,
} from './jobsApi.ts';
import {
  ChainAdmissionForm,
  JobSubmissionForm,
  type ChainDraft,
  type JobDraft,
} from './JobForms.tsx';
import { ChainSummary, JobDetails } from './JobDetails.tsx';
import { ExternalWaitObserver } from './ExternalWaits.tsx';
import { AutomaticReleaseDetails } from './AutomaticChains.tsx';
import styles from './NightshiftPage.module.css';

type ReadinessState =
  | { status: 'loading' }
  | { status: 'loaded'; data: ModelReadiness }
  | { status: 'error'; message: string };

export function AgentRouteTable({ data }: { data: ModelReadiness }) {
  return (
    <div
      className={styles.tableWrap}
      tabIndex={0}
      role="region"
      aria-label="Agent route readiness table"
    >
      <table className={styles.table}>
        <caption>Current configuration for newly admitted tasks</caption>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Configured route</th>
            <th scope="col">Provider / requested model</th>
            <th scope="col">Schema inspection</th>
            <th scope="col">Reachability</th>
            <th scope="col">Live verification</th>
            <th scope="col">Requested inference policy</th>
          </tr>
        </thead>
        <tbody>
          {data.routes.map((route) => (
            <tr key={route.role}>
              <th scope="row">{route.role}</th>
              <td>
                <strong>{route.profile}</strong>
                <span>{route.configured ? 'Configured' : 'Unavailable'}</span>
                {route.reason ? (
                  <p className={styles.reason}>{route.reason}</p>
                ) : null}
              </td>
              <td>
                <strong>{route.provider}</strong>
                <span>{route.requested_model ?? 'No model selected'}</span>
              </td>
              <td>
                {route.schema_compatible
                  ? 'Compatible contract'
                  : 'Unavailable'}
              </td>
              <td>{route.reachability}</td>
              <td>
                {route.live_verified ? 'Verified' : 'Unverified'}
                <span>Role evaluation: {route.role_evaluation}</span>
              </td>
              <td>
                {route.policy === 'local-only'
                  ? 'Local only requested'
                  : 'Provider policy'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentRoutesPanel() {
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<ReadinessState>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    void fetchModelReadiness(
      AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    )
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'loaded', data });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({
            status: 'error',
            message:
              'Agent route readiness is unavailable. Check the local Haze server and retry.',
          });
      });
    return () => controller.abort();
  }, [refresh]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h2>Agent routes</h2>
          <p>Provider and model readiness for Manager and specialist agents.</p>
        </div>
        <Button
          disabled={state.status === 'loading'}
          onClick={() => {
            setState({ status: 'loading' });
            setRefresh((value) => value + 1);
          }}
        >
          Refresh readiness
        </Button>
      </header>
      <p>
        Configuration, schema compatibility, reachability, and live role
        evaluation are separate checks. An available endpoint does not establish
        reasoning quality. Admitted tasks keep their original routes when
        configuration changes.
      </p>
      {state.status === 'loading' ? (
        <p role="status">Inspecting agent routes...</p>
      ) : null}
      {state.status === 'error' ? (
        <StateMessage kind="error" title="Readiness unavailable">
          {state.message}
        </StateMessage>
      ) : null}
      {state.status === 'loaded' ? (
        <>
          <p className={styles.checked}>
            Checked{' '}
            <time dateTime={state.data.checked_at}>
              {new Date(state.data.checked_at).toLocaleString()}
            </time>
          </p>
          <AgentRouteTable data={state.data} />
        </>
      ) : null}
      <p className={styles.note}>
        This view inspects routes without running inference. Direct calls use
        Haze call and token limits. A local endpoint alone does not establish
        local-only compute, and direct calls have no job-chain spend cap.
      </p>
    </div>
  );
}

type Snapshot = {
  readiness: NightshiftJobReadiness | null;
  chains: NightshiftChain[];
  jobs: NightshiftJobSummary[];
  selected: NightshiftJob | null;
  chain: NightshiftChain | null;
};
type MutationRecord = NightshiftChain | NightshiftJob;

export function currentNightshiftAuthority(
  task: TaskRecord,
  assignmentId?: string,
) {
  const assignment = assignmentId
    ? task.assignments.find(
        (entry) =>
          entry.id === assignmentId &&
          entry.run_id === task.current_run_id &&
          entry.objective_revision === task.objective_revision,
      )
    : undefined;
  if (assignmentId && !assignment)
    throw new Error(
      'The selected assignment is not part of the current task revision.',
    );
  return {
    expected_run_id: task.current_run_id,
    expected_generation: task.generation,
    expected_objective_revision: task.objective_revision,
    expected_state_revision: task.state_revision,
    ...(assignment
      ? {
          expected_assignment_id: assignment.id,
          expected_assignment_revision: assignment.revision,
        }
      : {}),
  };
}

export function NightshiftPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const [client] = useState(() => new NightshiftClient());
  const [data, setData] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<{
    jobId: string;
    items: NightshiftEventPage['events'];
  }>({ jobId: '', items: [] });
  const [observing, setObserving] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [observationError, setObservationError] = useState<string | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [automaticReadiness, setAutomaticReadiness] =
    useState<AutomaticReadiness | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const intent = useRef(new MutationIntent());
  const cursor = useRef({ jobId: '', after: 0 });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!observing) return;
    const controller = new AbortController();
    setAutomaticReadiness(null);
    void client
      .automationReadiness(
        AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      )
      .then((value) => {
        if (!controller.signal.aborted) setAutomaticReadiness(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAutomaticReadiness(null);
      });
    return () => controller.abort();
  }, [client, observing, refresh]);

  useEffect(() => {
    if (!observing) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let readiness: NightshiftJobReadiness | null = null;
    setReadinessError(null);
    setData((previous) =>
      previous ? { ...previous, readiness: null } : previous,
    );
    // CLI capability inspection can be slow or unavailable. Historical inbox
    // readback must render independently of new-submission readiness.
    void client
      .readiness(
        AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
      )
      .then((capabilities) => {
        if (controller.signal.aborted) return;
        readiness = capabilities;
        setData((previous) =>
          previous ? { ...previous, readiness: capabilities } : previous,
        );
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setReadinessError(
            'Runtime readiness is unavailable. Saved jobs remain visible; new submissions stay blocked.',
          );
      });
    const load = async () => {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15_000),
      ]);
      try {
        const [chains, jobs, selected] = await Promise.all([
          client.chains(signal),
          client.jobs(signal),
          jobId
            ? client.job(jobId, signal).catch(() => null)
            : Promise.resolve(null),
        ]);
        const chain = selected
          ? (chains.chains.find((entry) => entry.id === selected.chain_id) ??
            (await client.chain(selected.chain_id, signal)))
          : null;
        if (controller.signal.aborted) return;
        setData({
          readiness,
          chains: chains.chains,
          jobs: jobs.jobs,
          selected,
          chain,
        });
        setObservationError(
          jobId && !selected
            ? 'This job is unavailable to the current local identity.'
            : null,
        );
        if (jobId && selected) {
          if (cursor.current.jobId !== jobId)
            cursor.current = { jobId, after: 0 };
          const page = await client.events(jobId, cursor.current.after, signal);
          if (controller.signal.aborted) return;
          cursor.current.after = page.next_cursor;
          setEvents((previous) => ({
            jobId,
            items: [
              ...new Map(
                [
                  ...(previous.jobId === jobId ? previous.items : []),
                  ...page.events,
                ].map((event) => [event.cursor, event]),
              ).values(),
            ].slice(-100),
          }));
        }
      } catch {
        if (!controller.signal.aborted)
          setObservationError(
            'Job observation is unavailable. Saved data remains visible; reconnect or refresh when the local server is running.',
          );
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void load();
          }, 2000);
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [client, jobId, observing, refresh]);

  const applyRecord = (record: MutationRecord) => {
    setData((previous) => {
      if (!previous) return previous;
      if ('execution_state' in record)
        return {
          ...previous,
          jobs: [
            summarizeNightshiftJob(record),
            ...previous.jobs.filter((entry) => entry.id !== record.id),
          ].slice(0, 100),
          selected: record,
        };
      return {
        ...previous,
        chains: [
          record,
          ...previous.chains.filter((entry) => entry.id !== record.id),
        ].slice(0, 100),
        chain: previous.chain?.id === record.id ? record : previous.chain,
      };
    });
  };
  const mutate = async (
    identity: string,
    build: () => Promise<unknown>,
    send: (
      body: unknown,
      key: string,
      signal: AbortSignal,
    ) => Promise<MutationRecord>,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const prepared = await intent.current.prepare(identity, build);
      const result = await send(
        prepared.body,
        prepared.key,
        AbortSignal.timeout(30_000),
      );
      if (!mounted.current) return;
      applyRecord(result);
      setNotice(
        'The server recorded the request. Repeating an unchanged request returns the same handle. Historical candidates remain unreviewed.',
      );
      if ('execution_state' in result)
        void navigate(`/nightshift/${encodeURIComponent(result.id)}`);
      setRefresh((value) => value + 1);
    } catch (failure) {
      if (!mounted.current) return;
      setError(
        (failure instanceof Error ? failure.message : 'The request failed.') +
          ' An unchanged retry keeps the original request and key. Refresh persisted state before authorizing additional work.',
      );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const admit = (draft: ChainDraft) => {
    void mutate(
      `admit:${JSON.stringify(draft)}`,
      async () => {
        const task = await client.task(
          draft.task_id,
          AbortSignal.timeout(15_000),
        );
        const common = {
          task_id: draft.task_id,
          total_runs: draft.total_runs,
          max_jobs: draft.max_jobs,
          max_attempts: draft.max_attempts,
          lifetime_seconds: draft.lifetime_seconds,
          ...currentNightshiftAuthority(task),
          privacy: draft.privacy,
          max_spend_usd: draft.privacy === 'cloud-ok' ? null : 0,
        };
        if (!draft.automatic_opt_in)
          return {
            ...common,
            schema_version: 'haze.nightshift.chain.admission.v1',
            automatic_followup_runs: 0,
          };
        if (!automaticReadiness?.ready || !automaticReadiness.released)
          throw new Error(
            'The server has not released automatic-chain admission.',
          );
        let inputRefs: unknown;
        try {
          inputRefs = JSON.parse(draft.input_refs_text) as unknown;
        } catch {
          throw new Error(
            'Initial input references must be an exact JSON array.',
          );
        }
        return {
          ...common,
          schema_version: 'haze.nightshift.chain.admission.v2',
          automatic_opt_in: true,
          automatic_followup_runs: draft.automatic_followup_runs,
          ...(draft.previous_chain_id
            ? { previous_chain_id: draft.previous_chain_id }
            : {}),
          initial_progress: {
            schema_version: 'haze.nightshift.progress.v1',
            purpose: draft.purpose,
            instruction: draft.instruction,
            unresolved_deliverables: ['objective'],
            input_refs: inputRefs,
            output_refs: [],
            review_objections: [],
            failure_causes: [],
            last_consumed_result_cursor: 0,
          },
        };
      },
      (body, key, signal) => client.admitChain(body, key, signal),
    );
  };
  const submit = (draft: JobDraft) => {
    void mutate(
      `submit:${JSON.stringify(draft)}`,
      async () => {
        const chain = await client.chain(
          draft.chain_id,
          AbortSignal.timeout(15_000),
        );
        const task = await client.task(
          chain.task_id,
          AbortSignal.timeout(15_000),
        );
        let inputRefs: unknown;
        try {
          inputRefs = JSON.parse(draft.input_refs_text) as unknown;
        } catch {
          throw new Error(
            'Input references must be a JSON array with exact id, version and sha256 fields.',
          );
        }
        return {
          schema_version: 'haze.nightshift.job.submit.v1',
          chain_id: chain.id,
          expected_chain_revision: chain.revision,
          ...currentNightshiftAuthority(task),
          prompt: draft.prompt,
          input_refs: inputRefs,
          role: draft.role,
          n: draft.n,
          judge: draft.judge,
          budget: draft.budget,
          window: draft.window,
          ...(draft.fleet ? { fleet: draft.fleet } : {}),
          privacy: chain.grant.privacy,
          max_spend_usd: chain.grant.max_spend_usd,
        };
      },
      (body, key, signal) => client.submitJob(body, key, signal),
    );
  };
  const control = (
    chain: NightshiftChain,
    action: 'pause' | 'resume' | 'cancel' | 'close',
  ) => {
    void mutate(
      `control:${chain.id}:${action}`,
      async () => {
        const [fresh, task] = await Promise.all([
          client.chain(chain.id, AbortSignal.timeout(15_000)),
          client.task(chain.task_id, AbortSignal.timeout(15_000)),
        ]);
        return {
          schema_version:
            fresh.schema_version === 'haze.nightshift.chain.v2'
              ? 'haze.nightshift.chain.control.v2'
              : 'haze.nightshift.chain.control.v1',
          action,
          expected_chain_revision: fresh.revision,
          ...currentNightshiftAuthority(task),
        };
      },
      (body, key, signal) => client.controlChain(chain.id, body, key, signal),
    );
  };
  const propose = (chain: NightshiftChain, progressText: string) => {
    void mutate(
      `progress:${chain.id}:${progressText}`,
      async () => {
        const [fresh, task] = await Promise.all([
          client.chain(chain.id, AbortSignal.timeout(15000)),
          client.task(chain.task_id, AbortSignal.timeout(15000)),
        ]);
        let progress: unknown;
        try {
          progress = JSON.parse(progressText) as unknown;
        } catch {
          throw new Error(
            'Progress must be a versioned JSON object with exact references.',
          );
        }
        return {
          schema_version: 'haze.nightshift.chain.progress.proposal.v1',
          ...currentNightshiftAuthority(task),
          expected_chain_revision: fresh.revision,
          progress,
        };
      },
      async (body, key, signal) => {
        await client.proposeProgress(chain.id, body, key, signal);
        return client.chain(chain.id, signal);
      },
    );
  };
  const jobAction = (
    job: NightshiftJob,
    action: 'cancel' | 'reconcile' | 'select',
    value = '',
  ) => {
    void mutate(
      `${action}:${job.id}:${value}`,
      async () => {
        const [fresh, chain, task] = await Promise.all([
          client.job(job.id, AbortSignal.timeout(15_000)),
          client.chain(job.chain_id, AbortSignal.timeout(15_000)),
          client.task(job.task_id, AbortSignal.timeout(15_000)),
        ]);
        if (action === 'select' && !fresh.receipt)
          throw new Error('No exact candidate receipt is available.');
        return {
          schema_version: `haze.nightshift.job.${action}.v1`,
          ...currentNightshiftAuthority(
            task,
            action === 'select' ? value : undefined,
          ),
          expected_chain_revision: chain.revision,
          expected_job_revision: fresh.revision,
          ...(action === 'reconcile' ? { remote_id: value } : {}),
          ...(action === 'select'
            ? {
                candidate: fresh.receipt!.artifact,
                input_refs: fresh.input_refs,
                reviewed: false,
              }
            : {}),
        };
      },
      (body, key, signal) =>
        action === 'cancel'
          ? client.cancelJob(job.id, body, key, signal)
          : action === 'reconcile'
            ? client.reconcileJob(job.id, body, key, signal)
            : client.selectResult(job.id, body, key, signal),
    );
  };
  const selected = jobId && data?.selected?.id === jobId ? data.selected : null;
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Nightshift candidate jobs</h1>
          <p>
            Bounded jobs under explicit grants and historical candidate results.
          </p>
        </div>
        <div className={styles.actions}>
          <Button onClick={() => setObserving((value) => !value)}>
            {observing
              ? 'Stop browser observation'
              : 'Resume browser observation'}
          </Button>
          <Button
            onClick={() => {
              setObserving(true);
              setRefresh((value) => value + 1);
            }}
          >
            Refresh saved state
          </Button>
        </div>
      </header>
      <p>
        {observing
          ? 'Observing persisted server state.'
          : 'Browser observation stopped. Jobs and server monitoring continue.'}{' '}
        Closing this page does not cancel remote work or start another Haze run.
      </p>
      {error ? (
        <StateMessage
          kind="error"
          title="Nightshift request or observation failed"
        >
          {error}
        </StateMessage>
      ) : null}
      {observationError ? (
        <StateMessage kind="error" title="Nightshift observation interrupted">
          {observationError}
        </StateMessage>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!data ? <p role="status">Loading saved Nightshift jobs...</p> : null}
      <section className={styles.panel} aria-label="Candidate job readiness">
        <h2>Candidate job readiness</h2>
        {readinessError ? <p role="status">{readinessError}</p> : null}
        {data?.readiness ? (
          <>
            <p>
              CLI: {data.readiness.cli_available ? 'available' : 'unavailable'}{' '}
              · schema:{' '}
              {data.readiness.schema_compatible ? 'compatible' : 'unsupported'}{' '}
              · daemon:{' '}
              {data.readiness.runtime_reachable ? 'reachable' : 'unavailable'} ·
              local-only enforcement:{' '}
              {data.readiness.local_only_enforced ? 'verified' : 'unverified'} ·
              cloud generation:{' '}
              {data.readiness.cloud_enforced ? 'verified' : 'unverified'}
            </p>
            <p>
              Submission:{' '}
              <strong>{data.readiness.ready ? 'available' : 'blocked'}</strong>.{' '}
              {data.readiness.reason}
            </p>
            <p>
              Runtime version: {data.readiness.runtime_version ?? 'unknown'} ·
              adapter: {data.readiness.adapter_version}.
            </p>
          </>
        ) : (
          <p>Runtime readiness has not been established.</p>
        )}
        <p>
          New candidate chains default to cloud allowed with no cloud spend cap.
          Each job keeps its admitted chain’s policy. Normal Haze agent calls
          use their own model routes and Haze call/token limits.
        </p>
      </section>
      <AutomaticReleaseDetails data={automaticReadiness} />
      <div className={styles.formGrid}>
        <ChainAdmissionForm
          busy={busy}
          available={data?.readiness?.ready ?? false}
          readiness={data?.readiness ?? null}
          automaticAvailable={Boolean(
            automaticReadiness?.ready && automaticReadiness.released,
          )}
          automaticReason={automaticReadiness?.reason ?? null}
          onSubmit={admit}
        />
        <JobSubmissionForm
          chains={data?.chains ?? []}
          readiness={data?.readiness ?? null}
          busy={busy}
          onSubmit={submit}
        />
      </div>
      <p className={styles.note}>
        Failed or ambiguous mutations retain their exact request and idempotency
        key for an unchanged retry.{' '}
        <Button
          size="small"
          disabled={busy}
          onClick={() => {
            intent.current.clear();
            setNotice(
              'Saved request identity cleared. Read current state before submitting new authority.',
            );
          }}
        >
          Clear saved request identity
        </Button>
      </p>
      <section aria-label="Persisted candidate jobs">
        <h2>Saved jobs</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Execution</th>
                <th scope="col">Judge outcome</th>
                <th scope="col">Receipt</th>
                <th scope="col">Cancellation</th>
              </tr>
            </thead>
            <tbody>
              {(data?.jobs ?? []).map((job) => (
                <tr key={job.id}>
                  <th scope="row">
                    <Link to={`/nightshift/${job.id}`}>{job.id}</Link>
                    <p>
                      <Link to={`/task/${job.task_id}`}>Task</Link> · explicit
                      grant
                    </p>
                  </th>
                  <td>{job.execution_state}</td>
                  <td>{job.judge_status}</td>
                  <td>
                    {job.receipt_available
                      ? 'Historical candidate retained'
                      : 'Not available'}
                  </td>
                  <td>
                    {job.execution_state === 'rejected'
                      ? 'Not dispatched; rejected before acceptance'
                      : job.cancellation.remote_termination_confirmed
                        ? 'Termination confirmed'
                        : job.cancellation.requested
                          ? 'Requested; termination unconfirmed'
                          : 'Not requested; termination unconfirmed'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data?.jobs.length === 0 ? (
          <p>
            No persisted jobs. Submit a bounded request under an admitted chain.
          </p>
        ) : null}
      </section>
      {selected ? (
        <ExternalWaitObserver
          taskId={selected.task_id}
          jobId={selected.id}
          observing={observing}
        />
      ) : null}
      {selected ? (
        <JobDetails
          job={selected}
          events={events.jobId === selected.id ? events.items : []}
          busy={busy}
          canReconcile={canReconcileNightshiftJob(data?.readiness ?? null)}
          onCancel={() => jobAction(selected, 'cancel')}
          onReconcile={(remoteId) => jobAction(selected, 'reconcile', remoteId)}
          onSelect={(assignmentId) =>
            jobAction(selected, 'select', assignmentId)
          }
        />
      ) : null}
      <section aria-label="Chain grants">
        <h2>Chain grants</h2>
        {(data?.chains ?? []).map((chain) => (
          <ChainSummary
            key={chain.id}
            chain={chain}
            busy={busy}
            observing={observing}
            onPropose={(text) => propose(chain, text)}
            onControl={(action) => control(chain, action)}
          />
        ))}
        {data?.chain &&
        !data.chains.some((chain) => chain.id === data.chain!.id) ? (
          <ChainSummary
            chain={data.chain}
            busy={busy}
            observing={observing}
            onPropose={(text) => propose(data.chain!, text)}
            onControl={(action) => control(data.chain!, action)}
          />
        ) : null}
      </section>
      <details className={styles.panel}>
        <summary>Inspect agent provider routes</summary>
        <AgentRoutesPanel />
      </details>
    </div>
  );
}
