import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { z } from 'zod';
import {
  reductionProgrammeCreateSchema,
  reductionProgrammeHistorySchema,
  type ReductionProgrammeMutationReceipt,
  type ReductionProgrammePhase,
  type ReductionProgrammeView,
} from '../../../../app/contracts/damage-reduction-programme.ts';
import type { ReductionPreviewRequest } from '../../../../app/contracts/damage-reduction-plan.ts';
import { useAgentRun } from '../dashboard/useAgentRun.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { BackLink } from '../../shared/ui/BackLink.tsx';
import { ReductionIntake } from './ReductionIntake.tsx';
import { ExactSource } from './ReductionResults.tsx';
import {
  ProgrammeMutationIntent,
  reductionProgrammeClient,
} from './programme-api.ts';
import {
  ProgrammeAttempts,
  ProgrammeCapacity,
  ProgrammeListPanel,
  canRequestProgrammePhase,
} from './ProgrammeViews.tsx';
import {
  ProgrammeInputEditor,
  ProgrammeMetadataEditor,
  ProgrammeRecordEditor,
  type ProgrammeMutation,
} from './ProgrammeEditors.tsx';
import styles from './DamageReductionPage.module.css';
import { PilotDeliveryResults } from './PilotResults.tsx';
import {
  ProgrammePilotInputEditor,
  ProgrammePilotRecordEditor,
} from './ProgrammePilot.tsx';
import {
  ProgrammeEvaluationInputEditor,
  ProgrammeEvaluationRecordEditor,
} from './ProgrammeEvaluation.tsx';
import { ProgrammeEvaluationResults } from './EvaluationResults.tsx';

export function ReductionProgrammePage() {
  const { programmeId } = useParams<{ programmeId: string }>();
  return programmeId && programmeId !== 'new' ? (
    <ProgrammeWorkspace key={programmeId} programmeId={programmeId} />
  ) : (
    <ProgrammeCreate />
  );
}

function ProgrammeHeader() {
  return (
    <header className={styles.header}>
      <BackLink>Back to the dashboard</BackLink>
      <p className={styles.eyebrow}>Programme coordination</p>
      <h1>Damage-reduction programme</h1>
      <p>
        Coordinate explicitly started bounded assessment, planning and
        pilot-draft and external-evaluation tasks while retaining exact
        revisions, sources and historical runs.
      </p>
      <p className={styles.note}>
        Preview, planning and pilot completion alone cannot grant an
        evaluated-effect conclusion. Evaluation support and scientific adoption
        are reported separately; World Model acceptance remains separate.
      </p>
      <Link to="/damage-reduction">Open standalone planning previews</Link>
    </header>
  );
}

function ProgrammeCreate() {
  const run = useAgentRun(undefined, 'haze.reduction.programme.create', {
    restoreFromStorage: false,
  });
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const [scientificOwner, setScientificOwner] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [budget, setBudget] = useState({
    max_model_calls: 400,
    max_tool_calls: 400,
    max_runs: 12,
    max_attempts_per_phase: 3,
  });
  const intent = useRef(new ProgrammeMutationIntent());
  const create = async (preview: ReductionPreviewRequest) => {
    const body = reductionProgrammeCreateSchema.parse({
      schema_version: 'haze.reduction.programme.create.v1',
      expected_revision: 0,
      title,
      accountable_owner: owner,
      scientific_owner: scientificOwner.trim() || null,
      preview,
      budget,
    });
    const receipt = await reductionProgrammeClient.create(
      body,
      intent.current.key('create', body),
    );
    intent.current.clear();
    await navigate(
      `/damage-reduction/programmes/${encodeURIComponent(receipt.programme_id)}`,
      { replace: true },
    );
  };
  return (
    <article className={styles.page}>
      <ProgrammeHeader />
      <section
        className={styles.card}
        aria-labelledby="create-programme-heading"
      >
        <h2 id="create-programme-heading">Save a programme</h2>
        <p>
          Saving retains the target, selected evidence and proposed digital
          rules. Start each assessment or planning phase explicitly from the
          saved programme.
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <ReductionIntake
          run={run}
          onError={setError}
          onSubmitPreview={create}
          submitLabel="Save programme inputs"
          detailsHeading="Programme ownership and limits"
        >
          <label>
            Programme title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={256}
              required
            />
          </label>
          <label>
            Accountable owner
            <input
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              maxLength={4096}
              required
            />
          </label>
          <label>
            Scientific owner, if designated
            <input
              value={scientificOwner}
              onChange={(event) => setScientificOwner(event.target.value)}
              maxLength={4096}
              placeholder="Not supplied; qualification remains a prerequisite"
            />
          </label>
          <p className={styles.note}>
            Names are recorded local attestations. Identity, workspace and
            execution mode are server-owned.
          </p>
          <details>
            <summary>Programme ceilings</summary>
            <p className={styles.note}>
              Limits are cumulative reservations and charges, within the
              existing per-run ceilings. They do not certify readiness or
              trigger automatic runs.
            </p>
            <div className={styles.twoColumn}>
              <label>
                Maximum model calls
                <input
                  type="number"
                  min={0}
                  max={400}
                  step={1}
                  value={budget.max_model_calls}
                  onChange={(event) =>
                    setBudget((value) => ({
                      ...value,
                      max_model_calls: Number(event.target.value),
                    }))
                  }
                  required
                />
              </label>
              <label>
                Maximum tool calls
                <input
                  type="number"
                  min={0}
                  max={400}
                  step={1}
                  value={budget.max_tool_calls}
                  onChange={(event) =>
                    setBudget((value) => ({
                      ...value,
                      max_tool_calls: Number(event.target.value),
                    }))
                  }
                  required
                />
              </label>
              <label>
                Maximum admitted runs
                <input
                  type="number"
                  min={1}
                  max={12}
                  step={1}
                  value={budget.max_runs}
                  onChange={(event) =>
                    setBudget((value) => ({
                      ...value,
                      max_runs: Number(event.target.value),
                    }))
                  }
                  required
                />
              </label>
              <label>
                Maximum attempts per phase
                <input
                  type="number"
                  min={1}
                  max={3}
                  step={1}
                  value={budget.max_attempts_per_phase}
                  onChange={(event) =>
                    setBudget((value) => ({
                      ...value,
                      max_attempts_per_phase: Number(event.target.value),
                    }))
                  }
                  required
                />
              </label>
            </div>
          </details>
        </ReductionIntake>
      </section>
      <ProgrammeListPanel />
    </article>
  );
}

function ProgrammeWorkspace({ programmeId }: { programmeId: string }) {
  const [view, setView] = useState<ReductionProgrammeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(true);
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] =
    useState<ReductionProgrammeMutationReceipt | null>(null);
  const [refresh, setRefresh] = useState(0);
  const intent = useRef(new ProgrammeMutationIntent());
  const mutationController = useRef<AbortController | null>(null);
  const recheck = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setReading(true);
    setReadError(null);
    reductionProgrammeClient
      .programme(programmeId, controller.signal)
      .then((current) => {
        if (!controller.signal.aborted) setView(current);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setReadError(
            cause instanceof Error
              ? cause.message
              : 'The saved programme is unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => controller.abort();
  }, [programmeId, refresh]);
  useEffect(() => {
    if (!view?.capacity.active_attempt_id || reading || readError) return;
    const timer = setTimeout(recheck, 2000);
    return () => clearTimeout(timer);
  }, [view?.capacity.active_attempt_id, reading, readError, recheck, refresh]);
  useEffect(() => {
    window.addEventListener('focus', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      mutationController.current?.abort();
    };
  }, [recheck]);
  const mutate: ProgrammeMutation = async (operation, body) => {
    if (pending || reading)
      throw new Error(
        'Wait for the current programme operation or read to finish.',
      );
    const controller = new AbortController();
    mutationController.current = controller;
    setPending(true);
    setError(null);
    try {
      const key = intent.current.key(operation, body);
      const result =
        operation === 'phase'
          ? await reductionProgrammeClient.startPhase(
              programmeId,
              body,
              key,
              controller.signal,
            )
          : operation === 'record'
            ? await reductionProgrammeClient.record(
                programmeId,
                body,
                key,
                controller.signal,
              )
            : await reductionProgrammeClient.revise(
                programmeId,
                body,
                key,
                controller.signal,
              );
      setReceipt(result);
      intent.current.clear();
      recheck();
      return result;
    } catch (cause) {
      const failure =
        cause instanceof Error
          ? cause
          : new Error('The programme operation was not confirmed.');
      setError(failure.message);
      throw failure;
    } finally {
      if (mutationController.current === controller)
        mutationController.current = null;
      setPending(false);
    }
  };
  const currentSupportUnavailable =
    !!readError ||
    reading ||
    pending ||
    (receipt !== null && receipt.revision > (view?.programme.revision ?? 0));
  return (
    <article className={styles.page}>
      <ProgrammeHeader />
      <p className={styles.identifier}>Programme {programmeId}</p>
      {(readError || error) && (
        <p role="alert" className={styles.error}>
          {readError ?? error}
        </p>
      )}
      {reading && (
        <p role="status">
          Rechecking the saved programme, exact linked runs and current source
          access…
        </p>
      )}
      <div className={styles.actions}>
        <Button onClick={recheck} disabled={pending || reading}>
          Recheck programme and capacity
        </Button>
        <Link to="/damage-reduction/programmes/new">
          Create another programme
        </Link>
      </div>
      {receipt && (
        <p className={styles.notice} role="status">
          Saved {receipt.operation.replaceAll('_', ' ')} receipt at revision{' '}
          {receipt.revision}.
          {receipt.attempt && (
            <>
              {' '}
              Exact admitted task {receipt.attempt.task_id}, run{' '}
              {receipt.attempt.run_id}. Execution is reported separately below.
            </>
          )}
        </p>
      )}
      {readError && view && (
        <p className={styles.notice}>
          Current programme status is unavailable. The last successful read is
          retained for context; current result eligibility is withheld.
        </p>
      )}
      {view ? (
        <ProgrammeDetailView
          view={
            currentSupportUnavailable
              ? {
                  ...view,
                  pilot: undefined,
                  evaluation: undefined,
                  attempts: view.attempts.map((entry) => ({
                    ...entry,
                    currency: 'stale',
                    result_status: 'unavailable',
                    preview: null,
                    pilot: null,
                    evaluation: null,
                    reasons: [
                      ...entry.reasons,
                      'Current programme status requires a fresh successful read; eligibility is temporarily withheld.',
                    ],
                  })),
                }
              : view
          }
          pending={currentSupportUnavailable}
          currentSupportAvailable={!currentSupportUnavailable}
          mutate={mutate}
          onError={setError}
        />
      ) : (
        !reading && (
          <p>
            Programme data is unavailable. Refreshing a read does not start a
            new phase.
          </p>
        )
      )}
      <ProgrammeListPanel currentId={programmeId} />
    </article>
  );
}

export function ProgrammeDetailView({
  view,
  pending,
  mutate,
  onError,
  currentSupportAvailable = true,
}: {
  view: ReductionProgrammeView;
  pending: boolean;
  mutate: ProgrammeMutation;
  onError(message: string | null): void;
  currentSupportAvailable?: boolean;
}) {
  const { programme } = view;
  return (
    <>
      <section
        className={styles.card}
        aria-labelledby="programme-current-heading"
      >
        <h2 id="programme-current-heading">{programme.title}</h2>
        <p className={styles.identifier}>
          Programme {programme.id} · revision {programme.revision} · execution
          mode {programme.mode}
        </p>
        <dl className={styles.facts}>
          <div>
            <dt>Accountable owner</dt>
            <dd>{programme.accountable_owner}</dd>
          </div>
          <div>
            <dt>Scientific owner</dt>
            <dd>{programme.scientific_owner ?? 'Not supplied'}</dd>
          </div>
          <div>
            <dt>Physical endpoint and target</dt>
            <dd>
              {programme.preview.selection.target.scope.endpoint} ·{' '}
              {programme.preview.selection.target.relation.replaceAll('_', ' ')}{' '}
              fraction {programme.preview.selection.target.target_fraction}
            </dd>
          </div>
          <div>
            <dt>Population and period</dt>
            <dd>
              {programme.preview.selection.target.scope.population} ·{' '}
              {programme.preview.selection.target.scope.period.start} to{' '}
              {programme.preview.selection.target.scope.period.end}
            </dd>
          </div>
          <div>
            <dt>Ordinary management</dt>
            <dd>{programme.preview.selection.target.comparator}</dd>
          </div>
          <div>
            <dt>Proposed intervention</dt>
            <dd>{programme.preview.selection.target.intervention}</dd>
          </div>
        </dl>
        <p className={styles.notice}>
          {currentSupportAvailable ? (
            <>
              Scientific qualification:{' '}
              {view.evaluation?.qualification.status ?? 'unqualified'}.
            </>
          ) : (
            'Current scientific qualification is unavailable while programme support is rechecked.'
          )}{' '}
          {currentSupportAvailable &&
          view.evaluation?.achieved_reduction &&
          view.evaluation.claim.eligible &&
          view.evaluation.claim.label ===
            'external_evaluation_supports_registered_target'
            ? 'The governed external evaluation conclusion appears below with its scope and reproduction limits.'
            : 'No achieved reduction is established.'}{' '}
          Programme coordination does not grant World Model acceptance.
        </p>
      </section>
      <ProgrammeCapacity capacity={view.capacity} />
      <ProgrammePilotInputEditor
        view={view}
        pending={pending}
        mutate={mutate}
        onError={onError}
      />
      <ProgrammePhaseStarts view={view} pending={pending} mutate={mutate} />
      <ProgrammeEvaluationInputEditor
        view={view}
        pending={pending}
        mutate={mutate}
        onError={onError}
      />
      <section
        className={styles.card}
        aria-labelledby="programme-attempts-heading"
      >
        <h2 id="programme-attempts-heading">
          Exact phase attempts and current results
        </h2>
        <ProgrammeAttempts attempts={view.attempts} />
      </section>
      <PilotDeliveryResults view={view} />
      <ProgrammeEvaluationResults view={view} />
      <ProgrammeEvaluationRecordEditor
        view={view}
        pending={pending}
        mutate={mutate}
        onError={onError}
      />
      <ProgrammePilotRecordEditor
        view={view}
        pending={pending}
        mutate={mutate}
        onError={onError}
      />
      <ProgrammeMetadataEditor
        programme={programme}
        pending={pending}
        mutate={mutate}
        onError={onError}
      />
      <ProgrammeInputEditor
        programme={programme}
        pending={pending}
        mutate={mutate}
        onError={onError}
      />
      <ProgrammeRecordEditor
        programme={programme}
        pending={pending}
        mutate={mutate}
        onError={onError}
      />
      <ProgrammeRecords view={view} />
      <ProgrammeHistory
        programmeId={programme.id}
        revision={programme.revision}
      />
    </>
  );
}

export function ProgrammePhaseStarts({
  view,
  pending,
  mutate,
}: {
  view: ReductionProgrammeView;
  pending: boolean;
  mutate: ProgrammeMutation;
}) {
  const [assessmentId, setAssessmentId] = useState('');
  const [planningId, setPlanningId] = useState('');
  const [registrationId, setRegistrationId] = useState('');
  const registrations = view.records.filter(
    (entry) => entry.record.kind === 'pilot_registration',
  );
  const selectedRegistration = registrations.some(
    (entry) => entry.id === registrationId,
  );
  const options = view.attempts.filter(
    (entry) =>
      entry.attempt.phase === 'assessment' &&
      entry.currency === 'current' &&
      entry.execution_status === 'completed' &&
      ['available', 'gap'].includes(entry.result_status),
  );
  const selectedAssessment = options.some(
    (entry) => entry.attempt.id === assessmentId,
  );
  const planningOptions = view.attempts.filter(
    (entry) =>
      entry.attempt.phase === 'planning' &&
      entry.currency === 'current' &&
      entry.execution_status === 'completed' &&
      entry.preview?.state === 'current' &&
      entry.preview.plan &&
      entry.preview.plan_review?.value.verdict === 'supported',
  );
  const selectedPlanning = planningOptions.some(
    (entry) => entry.attempt.id === planningId,
  );
  const start = async (phase: ReductionProgrammePhase) => {
    try {
      await mutate('phase', {
        schema_version: 'haze.reduction.programme.phase.v1',
        expected_revision: view.programme.revision,
        phase,
        ...(phase === 'planning'
          ? { assessment_attempt_id: assessmentId }
          : {}),
        ...(phase === 'pilot' ? { planning_attempt_id: planningId } : {}),
        ...(phase === 'evaluation' ? { registration_id: registrationId } : {}),
      });
    } catch {
      /* ProgrammeWorkspace displays the authoritative admission error. */
    }
  };
  return (
    <section className={styles.card} aria-labelledby="programme-start-heading">
      <h2 id="programme-start-heading">Explicit phase starts</h2>
      <p>
        Each start admits one bounded attempt against programme revision{' '}
        {view.programme.revision}. Earlier runs remain in history. Replacement
        attempts require another explicit start and consume remaining capacity.
      </p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={!canRequestProgrammePhase(view, 'assessment', pending)}
          onClick={() => void start('assessment')}
        >
          {view.attempts.some((entry) => entry.attempt.phase === 'assessment')
            ? 'Start another assessment attempt'
            : 'Start assessment phase'}
        </Button>
      </div>
      <div className={styles.form}>
        <label>
          Exact current assessment for the planning phase
          <select
            value={assessmentId}
            onChange={(event) => setAssessmentId(event.target.value)}
            disabled={pending || !!view.capacity.active_attempt_id}
          >
            <option value="">Choose an explicitly retained assessment</option>
            {options.map((entry) => (
              <option key={entry.attempt.id} value={entry.attempt.id}>
                Revision {entry.attempt.programme_revision} ·{' '}
                {entry.result_status} · run {entry.attempt.run_id}
              </option>
            ))}
          </select>
        </label>
        <div>
          <Button
            variant="primary"
            disabled={
              !selectedAssessment ||
              !canRequestProgrammePhase(view, 'planning', pending)
            }
            onClick={() => void start('planning')}
          >
            Start planning phase from selected assessment
          </Button>
        </div>
      </div>
      {!options.length && (
        <p className={styles.note}>
          A current completed assessment is required before planning.
          Insufficient evidence remains visible; the server determines which
          linked results can be used.
        </p>
      )}
      <div className={styles.form}>
        <label>
          Exact current reviewed planning attempt for the pilot draft
          <select
            value={planningId}
            disabled={pending || !!view.capacity.active_attempt_id}
            onChange={(event) => setPlanningId(event.target.value)}
          >
            <option value="">
              Choose an explicitly retained reviewed plan
            </option>
            {planningOptions.map((entry) => (
              <option key={entry.attempt.id} value={entry.attempt.id}>
                Revision {entry.attempt.programme_revision} ·{' '}
                {entry.preview!.plan!.value.state.replaceAll('_', ' ')} · run{' '}
                {entry.attempt.run_id}
              </option>
            ))}
          </select>
        </label>
        <div>
          <Button
            variant="primary"
            disabled={
              !selectedPlanning ||
              !view.programme.pilot_input_ref ||
              !canRequestProgrammePhase(view, 'pilot', pending)
            }
            onClick={() => void start('pilot')}
          >
            Start pilot draft from selected planning attempt
          </Button>
        </div>
      </div>
      <p className={styles.note}>
        Pilot drafting requires saved supplied pilot inputs and an exact current
        completed plan with its independent review. Conditional, blocked and
        evidence-gap plans can support a bounded labelled draft; missing
        scientific prerequisites remain visible. This start does not register a
        protocol or execute live delivery.
      </p>
      <div className={styles.form}>
        <label>
          Exact retained registration for external evaluation
          <select
            value={registrationId}
            disabled={pending || !!view.capacity.active_attempt_id}
            onChange={(event) => setRegistrationId(event.target.value)}
          >
            <option value="">Choose an exact retained registration</option>
            {registrations.map((entry) => {
              const status = view.pilot?.registrations.find(
                (item) => item.record_id === entry.id,
              );
              return (
                <option key={entry.id} value={entry.id}>
                  {entry.id} · {status?.currency ?? 'support unavailable'} ·{' '}
                  {status?.timing.replaceAll('_', ' ') ?? 'timing unknown'}
                </option>
              );
            })}
          </select>
        </label>
        <div>
          <Button
            variant="primary"
            disabled={
              !selectedRegistration ||
              !view.programme.evaluation_input_ref ||
              !canRequestProgrammePhase(view, 'evaluation', pending)
            }
            onClick={() => void start('evaluation')}
          >
            Start external evaluation from selected registration
          </Button>
        </div>
      </div>
      <p className={styles.note}>
        The selected external input must name this same exact registration.
        Technical checks may complete with below-target findings, missing
        science or insufficient delivery evidence; the server separately
        determines claim support. An absent scientific dossier cannot qualify a
        result.
      </p>
      <p className={styles.note}>
        Pause, cancel and unchanged-run controls remain in the linked task
        workspace. Changed objectives and successor runs require programme-aware
        admission; opening a task URL never creates a new run.
      </p>
    </section>
  );
}

export function ProgrammeRecords({ view }: { view: ReductionProgrammeView }) {
  return (
    <section
      className={styles.card}
      aria-labelledby="programme-context-heading"
    >
      <h2 id="programme-context-heading">
        Retained programme context and records
      </h2>
      {!view.records.length && (
        <p>
          No programme notes, attachments or typed records have been recorded.
        </p>
      )}
      {view.records.map((entry) => (
        <div key={entry.id} className={styles.source}>
          <p>
            Revision {entry.programme_revision} · {entry.record.kind} ·
            {entry.record.kind === 'note' || entry.record.kind === 'attachment'
              ? 'historical context'
              : 'retained programme domain record'}
          </p>
          {entry.record.kind === 'note' ? (
            <p className={styles.identifier}>{entry.record.text}</p>
          ) : entry.record.kind === 'attachment' ? (
            <>
              <p>{entry.record.description}</p>
              <ExactSource
                reference={entry.record.artifact}
                label="Exact historical attachment"
              />
            </>
          ) : (
            <details>
              <summary>Exact typed record fields</summary>
              <p className={styles.note}>
                Current applicability is shown in the Pilot, Delivery and
                Evaluation panels. A retained record alone does not establish an
                achieved reduction.
              </p>
              <pre className={styles.sourceText}>
                {JSON.stringify(entry.record, null, 2)}
              </pre>
            </details>
          )}
          {entry.task_binding && (
            <p className={styles.identifier}>
              Original task {entry.task_binding.task_id}; exact run{' '}
              {entry.task_binding.run_id}; objective revision{' '}
              {entry.task_binding.objective_revision}. This attachment does not
              recreate its reservation or make its result current.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

function ProgrammeHistory({
  programmeId,
  revision,
}: {
  programmeId: string;
  revision: number;
}) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<z.infer<
    typeof reductionProgrammeHistorySchema
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPending(true);
    setError(null);
    reductionProgrammeClient
      .history(programmeId, offset, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setHistory(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Programme history is unavailable.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
  }, [open, programmeId, revision, offset]);
  return (
    <details
      className={styles.card}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Programme revision and admission history</summary>
      {pending && <p role="status">Loading a bounded history page…</p>}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {history && <ProgrammeHistoryView history={history} />}
      <div className={styles.actions}>
        {offset > 0 && (
          <Button disabled={pending} onClick={() => setOffset(0)}>
            Newest history
          </Button>
        )}
        {history?.next_offset !== null &&
          history?.next_offset !== undefined && (
            <Button
              disabled={pending}
              onClick={() => setOffset(history.next_offset!)}
            >
              Older history page
            </Button>
          )}
      </div>
    </details>
  );
}

export function ProgrammeHistoryView({
  history,
}: {
  history: z.infer<typeof reductionProgrammeHistorySchema>;
}) {
  return (
    <>
      <ol>
        {history.revisions.map((entry) => (
          <li key={entry.revision}>
            <p>
              <strong>Revision {entry.revision}</strong> ·{' '}
              {entry.kind.replaceAll('_', ' ')} ·{' '}
              <time dateTime={entry.created_at}>{entry.created_at}</time>
            </p>
            <p>{entry.reason}</p>
            <p className={styles.note}>
              {entry.invalidated_phases.length
                ? `Affected phases: ${entry.invalidated_phases.join(', ')}.`
                : 'No phase was invalidated by this revision.'}
            </p>
          </li>
        ))}
      </ol>
      <p className={styles.note}>
        This bounded page includes {history.attempts.length} exact phase links
        and {history.records.length} context records. Current eligibility comes
        from the programme projection, not the revision history.
      </p>
    </>
  );
}
