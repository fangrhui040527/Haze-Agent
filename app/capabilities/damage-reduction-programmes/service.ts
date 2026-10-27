import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { ArtifactRef } from '../../contracts/artifacts.js';
import {
  reductionProgrammeCreateSchema,
  reductionProgrammeHistorySchema,
  reductionProgrammeListSchema,
  reductionProgrammePhaseRequestSchema,
  reductionProgrammeRecordRequestSchema,
  reductionProgrammeRevisionRequestSchema,
  type ReductionProgrammeAttempt,
  type ReductionProgrammeMutationReceipt,
  type ReductionProgrammePhase,
  type ReductionProgrammeRevision,
  type ReductionProgrammeSnapshot,
} from '../../contracts/damage-reduction-programme.js';
import {
  taskRequestSchema,
  TaskError,
  type TaskIdentity,
} from '../../contracts/tasks.js';
import type { ControlReceipt, TaskControl } from '../../contracts/controls.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import { candidateEvidenceReferences } from '../damage-reduction-planning/planning.js';
import {
  pilotInputSchema,
  type PilotInput,
} from '../../contracts/damage-reduction-pilot.js';
import {
  pilotArtifactContent,
  pilotEvidenceReferences,
  pilotRequestSchema,
} from '../damage-reduction-planning/pilot-workflow.js';
import { validatePilotRecord, isPilotRecord } from './pilot-records.js';
import { evaluationRequestSchema } from '../damage-reduction-planning/evaluation-workflow.js';
import {
  evaluationSelectedReferences,
  deriveEvaluationMethodContext,
  isEvaluationRecord,
  validateEvaluationRecord,
  embeddedEvaluationReferences,
  evaluationContent,
} from './evaluation-records.js';
import type { ReductionProgrammeRepository } from './repository.js';
import {
  programmeCapacity,
  programmeInputFingerprint,
  projectReductionProgramme,
  terminalProgrammeRun,
  buildPilotRecordContext,
} from './projection.js';
import type {
  ProgrammeCoordination,
  ProgrammeHost,
  ProgrammeScope,
  ProgrammeTaskMutation,
} from './ports.js';

const exact = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
const refKey = (value: ArtifactRef) =>
  `${value.id}:${value.version}:${value.sha256}`;
function fail(code: string, message: string, status = 409): never {
  throw new TaskError(status, code, message);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    return fail(
      'invalid_programme_request',
      'Send the bounded versioned programme request with its expected revision.',
      400,
    );
  return result.data;
}

export class ReductionProgrammeService {
  constructor(
    readonly repository: ReductionProgrammeRepository,
    private readonly host: ProgrammeHost,
  ) {}
  private scope(identity: TaskIdentity, mode = this.host.mode): ProgrammeScope {
    return { ...identity, mode };
  }
  private expected(snapshot: ReductionProgrammeSnapshot, expected: number) {
    if (snapshot.revision !== expected)
      fail(
        'programme_revision_conflict',
        'Programme changed; read its current revision before retrying.',
      );
  }
  private bounded(snapshot: ReductionProgrammeSnapshot) {
    try {
      canonicalJson(snapshot, 65_536);
    } catch {
      fail(
        'programme_input_bound',
        'Programme snapshot exceeds the 64 KiB supported input envelope; split it explicitly.',
        422,
      );
    }
  }
  private append(
    scope: ProgrammeScope,
    previous: ReductionProgrammeSnapshot,
    next: ReductionProgrammeSnapshot,
    kind: ReductionProgrammeRevision['kind'],
    reason: string,
    invalidated: ReductionProgrammePhase[] = [],
  ) {
    this.bounded(next);
    this.repository.append(scope, previous.revision, {
      programme_id: next.id,
      revision: next.revision,
      previous_revision: previous.revision,
      kind,
      reason,
      snapshot: next,
      invalidated_phases: invalidated,
      created_at: next.updated_at,
    });
  }
  private saveReceipt(
    scope: ProgrammeScope,
    key: string,
    hash: string,
    programme: ReductionProgrammeSnapshot,
    operation: ReductionProgrammeMutationReceipt['operation'],
    attempt: ReductionProgrammeAttempt | null = null,
  ) {
    const receipt: ReductionProgrammeMutationReceipt = {
      schema_version: 'haze.reduction.programme.receipt.v1',
      programme_id: programme.id,
      revision: programme.revision,
      operation,
      attempt,
    };
    this.repository.saveReceipt(scope, key, hash, receipt);
    return receipt;
  }
  create(
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ): ReductionProgrammeMutationReceipt {
    const request = parse(reductionProgrammeCreateSchema, value);
    const scope = this.scope(identity),
      operation = `create:${key}`,
      hash = contractHash(request);
    return this.host.atomic(() => {
      const prior = this.repository.receipt(scope, operation, hash);
      if (prior) return prior;
      const at = new Date().toISOString();
      const snapshot: ReductionProgrammeSnapshot = {
        schema_version: 'haze.reduction.programme.v1',
        id: randomUUID(),
        revision: 1,
        mode: scope.mode,
        title: request.title,
        accountable_owner: request.accountable_owner,
        scientific_owner: request.scientific_owner,
        preview: request.preview,
        ...(request.pilot_input_ref === undefined
          ? {}
          : { pilot_input_ref: request.pilot_input_ref }),
        ...(request.evaluation_input_ref === undefined
          ? {}
          : { evaluation_input_ref: request.evaluation_input_ref }),
        ...(request.evaluation_dossier_ref === undefined
          ? {}
          : { evaluation_dossier_ref: request.evaluation_dossier_ref }),
        budget: request.budget,
        created_at: at,
        updated_at: at,
      };
      this.bounded(snapshot);
      this.repository.create(scope, {
        programme_id: snapshot.id,
        revision: 1,
        previous_revision: 0,
        kind: 'create',
        reason:
          'Explicit operator programme creation; no task is automatically started.',
        snapshot,
        invalidated_phases: [],
        created_at: at,
      });
      return this.saveReceipt(scope, operation, hash, snapshot, 'create');
    });
  }
  read(id: string, identity: TaskIdentity) {
    const project = () => {
      const scope = this.scope(identity);
      return projectReductionProgramme(
        this.repository.get(scope, id),
        this.repository.attempts(scope, id),
        this.repository.records(scope, id),
        this.host,
        identity,
      );
    };
    return this.host.withEvidenceRead
      ? this.host.withEvidenceRead(project)
      : project();
  }
  evaluationContext(taskId: string, identity: TaskIdentity) {
    const resolve = () => this.resolveEvaluationContext(taskId, identity);
    return this.host.withEvidenceRead
      ? this.host.withEvidenceRead(resolve)
      : resolve();
  }
  private resolveEvaluationContext(taskId: string, identity: TaskIdentity) {
    const task = this.host.readTask(taskId, identity);
    const request = evaluationRequestSchema.parse(
      task.corrections.findLast((item) => item.scope !== undefined)?.scope ??
        task.original_request.scope,
    );
    const scope = this.scope(identity);
    const snapshot = this.repository.get(scope, request.programme_id);
    const records = this.repository.records(scope, snapshot.id);
    const attempts = this.repository.attempts(scope, snapshot.id);
    const binding = attempts.find(
      (item) =>
        item.task_id === taskId &&
        item.run_id === task.current_run_id &&
        item.objective_revision === task.objective_revision &&
        item.phase === 'evaluation',
    );
    if (!binding)
      fail(
        'programme_evaluation_attempt_required',
        'Evaluation execution requires an exact programme-admitted task/run/objective.',
      );
    if (
      refKey(request.input_ref) !== refKey(binding.evaluation_input_ref!) ||
      request.registration_id !== binding.registration_id ||
      (request.dossier_ref ? refKey(request.dossier_ref) : null) !==
        (binding.evaluation_dossier_ref
          ? refKey(binding.evaluation_dossier_ref)
          : null)
    )
      fail(
        'programme_evaluation_binding',
        'Evaluation request does not match its exact admitted programme inputs.',
      );
    if (
      programmeInputFingerprint(
        snapshot,
        'evaluation',
        binding.assessment_attempt_id,
        binding.planning_attempt_id ?? null,
        records,
        binding.registration_id,
      ) !== binding.input_fingerprint
    )
      fail(
        'programme_attempt_stale',
        'Evaluation programme inputs or delivery lineage changed; explicitly admit a replacement.',
      );
    const base = projectReductionProgramme(
      snapshot,
      attempts,
      records,
      this.host,
      identity,
      { includeEvaluation: false },
    );
    return deriveEvaluationMethodContext(
      snapshot,
      records,
      base,
      this.host,
      identity,
      request.input_ref,
      request.dossier_ref,
      request.registration_id,
    );
  }
  private page(options: { limit?: number; offset?: number } = {}) {
    const limit = options.limit ?? 10,
      offset = options.offset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      fail(
        'invalid_programme_pagination',
        'Use limit 1–10 and a nonnegative integer offset.',
        400,
      );
    return { limit, offset };
  }
  list(
    identity: TaskIdentity,
    options: { limit?: number; offset?: number } = {},
  ) {
    const { limit, offset } = this.page(options);
    const snapshots = this.repository.list(
      this.scope(identity),
      limit + 1,
      offset,
    );
    return reductionProgrammeListSchema.parse({
      schema_version: 'haze.reduction.programme.list.v1',
      programmes: snapshots.slice(0, limit),
      next_offset: snapshots.length > limit ? offset + limit : null,
    });
  }
  history(
    id: string,
    identity: TaskIdentity,
    options: { limit?: number; offset?: number } = {},
  ) {
    const { limit, offset } = this.page(options),
      scope = this.scope(identity);
    const revisions = this.repository.revisions(scope, id, limit + 1, offset);
    return reductionProgrammeHistorySchema.parse({
      schema_version: 'haze.reduction.programme.history.v1',
      revisions: revisions.slice(0, limit),
      attempts: this.repository.attempts(scope, id),
      records: this.repository.records(scope, id),
      next_offset: revisions.length > limit ? offset + limit : null,
    });
  }
  revise(
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ): ReductionProgrammeMutationReceipt {
    const request = parse(reductionProgrammeRevisionRequestSchema, value),
      scope = this.scope(identity),
      operation = `${id}:revise:${key}`,
      hash = contractHash(request);
    return this.host.atomic(() => {
      const receipt = this.repository.receipt(scope, operation, hash);
      if (receipt) return receipt;
      const previous = this.repository.get(scope, id);
      this.expected(previous, request.expected_revision);
      const next: ReductionProgrammeSnapshot = {
        ...previous,
        revision: previous.revision + 1,
        updated_at: new Date().toISOString(),
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.accountable_owner === undefined
          ? {}
          : { accountable_owner: request.accountable_owner }),
        ...(request.scientific_owner === undefined
          ? {}
          : { scientific_owner: request.scientific_owner }),
        ...(request.preview === undefined ? {} : { preview: request.preview }),
        ...(request.pilot_input_ref === undefined
          ? {}
          : { pilot_input_ref: request.pilot_input_ref }),
        ...(request.evaluation_input_ref === undefined
          ? {}
          : { evaluation_input_ref: request.evaluation_input_ref }),
        ...(request.evaluation_dossier_ref === undefined
          ? {}
          : { evaluation_dossier_ref: request.evaluation_dossier_ref }),
        ...(request.budget === undefined ? {} : { budget: request.budget }),
      };
      const attempts = this.repository.attempts(scope, id);
      const capacity = programmeCapacity(next, attempts, (taskId) =>
        this.host.readTask(taskId, identity),
      );
      const runCount = new Set(attempts.map((item) => item.run_id)).size;
      if (
        next.budget.max_model_calls <
          capacity.charged_model_calls + capacity.reserved_model_calls ||
        next.budget.max_tool_calls <
          capacity.charged_tool_calls + capacity.reserved_tool_calls ||
        next.budget.max_runs < runCount ||
        ['assessment', 'planning', 'pilot', 'evaluation'].some(
          (phase) =>
            attempts.filter((item) => item.phase === phase).length >
            next.budget.max_attempts_per_phase,
        )
      )
        fail(
          'programme_budget_in_use',
          'Budget cannot be lowered below charged usage, current reservations or admitted attempts.',
        );
      const invalidated: ReductionProgrammePhase[] = [];
      if (
        programmeInputFingerprint(previous, 'assessment') !==
        programmeInputFingerprint(next, 'assessment')
      )
        invalidated.push('assessment', 'planning', 'pilot', 'evaluation');
      else if (
        programmeInputFingerprint(previous, 'planning') !==
        programmeInputFingerprint(next, 'planning')
      )
        invalidated.push('planning', 'pilot', 'evaluation');
      else if (
        programmeInputFingerprint(previous, 'pilot') !==
        programmeInputFingerprint(next, 'pilot')
      )
        invalidated.push('pilot', 'evaluation');
      else if (
        programmeInputFingerprint(previous, 'evaluation') !==
        programmeInputFingerprint(next, 'evaluation')
      )
        invalidated.push('evaluation');
      this.append(
        scope,
        previous,
        next,
        invalidated.length ? 'inputs' : 'metadata',
        request.reason,
        invalidated,
      );
      for (const attempt of attempts.filter((item) =>
        invalidated.includes(item.phase),
      )) {
        const task = this.host.readTask(attempt.task_id, identity);
        const run = task.runs.find((item) => item.id === attempt.run_id);
        if (
          run &&
          !terminalProgrammeRun(run.status) &&
          task.current_run_id === attempt.run_id
        )
          this.host.controlTask(
            task.id,
            {
              schema_version: 'haze.task.control.v3',
              expected_objective_revision: task.objective_revision,
              expected_run_id: task.current_run_id,
              expected_generation: task.generation,
              expected_state_revision: task.state_revision,
              action: 'cancel',
              reason:
                'Material programme inputs changed; exact prior phase result is fenced.',
            },
            `programme-fence:${id}:${next.revision}:${attempt.id}`,
            identity,
          );
      }
      return this.saveReceipt(scope, operation, hash, next, 'revise');
    });
  }
  appendRecord(
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ): ReductionProgrammeMutationReceipt {
    const request = parse(reductionProgrammeRecordRequestSchema, value),
      scope = this.scope(identity),
      operation = `${id}:record:${key}`,
      hash = contractHash(request);
    return this.host.atomic(() => {
      const receipt = this.repository.receipt(scope, operation, hash);
      if (receipt) return receipt;
      const previous = this.repository.get(scope, id);
      this.expected(previous, request.expected_revision);
      const records = this.repository.records(scope, id);
      if (records.length >= 32)
        fail(
          'programme_record_bound',
          'This programme supports at most 32 retained context/pilot/delivery records; split further context explicitly.',
          422,
        );
      let binding: {
        task_id: string;
        run_id: string;
        objective_revision: number;
      } | null = null;
      if (request.record.kind === 'attachment') {
        const artifact = this.host.readArtifact(
          request.record.artifact,
          identity,
        );
        if (
          artifact.id !== request.record.artifact.id ||
          artifact.version !== request.record.artifact.version ||
          artifact.sha256 !== request.record.artifact.sha256
        )
          fail(
            'programme_attachment_mismatch',
            'Attachment must bind an accessible exact artifact version.',
          );
        if (artifact.task_id) {
          const task = this.host.readTask(artifact.task_id, identity);
          if (
            task.mode !== scope.mode ||
            !artifact.run_id ||
            !artifact.objective_revision ||
            !task.runs.some((run) => run.id === artifact.run_id)
          )
            fail(
              'programme_attachment_mode',
              'Preview attachments require the same identity/mode and an exact retained task/run.',
            );
          binding = {
            task_id: task.id,
            run_id: artifact.run_id,
            objective_revision: artifact.objective_revision,
          };
        }
      }
      const next = {
        ...previous,
        revision: previous.revision + 1,
        updated_at: new Date().toISOString(),
        ...(request.record.kind === 'pilot_amendment'
          ? { pilot_record_revision: (previous.pilot_record_revision ?? 0) + 1 }
          : {}),
      };
      const programmeRecord =
        request.record.kind !== 'note' && request.record.kind !== 'attachment';
      if (isPilotRecord(request.record)) {
        const context = buildPilotRecordContext(
          this.host,
          identity,
          this.read(id, identity).attempts,
          next.updated_at,
        );
        if (
          request.record.kind === 'pilot_registration' ||
          request.record.kind === 'pilot_amendment'
        ) {
          const draft = context.current_draft;
          const protocol =
            request.record.kind === 'pilot_registration'
              ? request.record.protocol_ref
              : request.record.amended_protocol_ref;
          if (
            !draft ||
            refKey(draft.protocol.artifact) !== refKey(protocol) ||
            refKey(draft.review.artifact) !==
              refKey(request.record.review_ref) ||
            (request.record.kind === 'pilot_registration' &&
              refKey(draft.feasibility.artifact) !==
                refKey(request.record.feasibility_ref))
          )
            fail(
              'programme_pilot_attempt_required',
              'Registration and amendments must adopt the exact current reviewed pilot attempt admitted by this programme.',
            );
        }
        validatePilotRecord(request.record, previous, records, context);
      }
      if (isEvaluationRecord(request.record))
        validateEvaluationRecord(
          request.record,
          records,
          this.read(id, identity),
          this.host,
          identity,
        );
      const record = {
        id: randomUUID(),
        programme_id: id,
        programme_revision: next.revision,
        created_at: next.updated_at,
        record: request.record,
        task_binding: binding,
        applicability: programmeRecord
          ? ('programme_record' as const)
          : ('historical_context' as const),
      };
      try {
        canonicalJson([...records, record], 131072);
      } catch {
        fail(
          'programme_record_bytes',
          'Retained records exceed the 128 KiB programme record envelope; split explicitly.',
          422,
        );
      }
      this.append(
        scope,
        previous,
        next,
        'record',
        programmeRecord
          ? 'Append exact programme lineage with server-derived status.'
          : 'Append historical context without changing phase inputs.',
        request.record.kind === 'pilot_amendment'
          ? ['pilot', 'evaluation']
          : isPilotRecord(request.record)
            ? ['evaluation']
            : [],
      );
      this.repository.record(scope, record);
      if (isPilotRecord(request.record)) {
        for (const attempt of this.repository
          .attempts(scope, id)
          .filter(
            (attempt) =>
              attempt.phase === 'evaluation' ||
              (request.record.kind === 'pilot_amendment' &&
                attempt.phase === 'pilot'),
          )) {
          const task = this.host.readTask(attempt.task_id, identity);
          const run = task.runs.find((run) => run.id === attempt.run_id);
          if (
            run &&
            !terminalProgrammeRun(run.status) &&
            task.current_run_id === attempt.run_id
          )
            this.host.controlTask(
              task.id,
              {
                schema_version: 'haze.task.control.v3',
                expected_objective_revision: task.objective_revision,
                expected_run_id: task.current_run_id,
                expected_generation: task.generation,
                expected_state_revision: task.state_revision,
                action: 'cancel',
                reason:
                  'Retained protocol or delivery facts changed; any replacement evaluation or pilot draft is explicit.',
              },
              `programme-amendment:${id}:${next.revision}:${attempt.id}`,
              identity,
            );
        }
      }
      return this.saveReceipt(scope, operation, hash, next, 'record');
    });
  }
  private selectedRefs(
    snapshot: ReductionProgrammeSnapshot,
    phase: ReductionProgrammePhase,
    identity: TaskIdentity,
  ): ArtifactRef[] {
    if (phase === 'evaluation')
      return evaluationSelectedReferences(
        snapshot,
        this.repository.records(this.scope(identity), snapshot.id),
        this.host,
        identity,
      );
    const refs = [
      ...snapshot.preview.selection.sources.map((source) => source.artifact),
      ...(phase !== 'assessment'
        ? candidateEvidenceReferences(snapshot.preview.candidate)
        : []),
    ];
    if (phase === 'pilot') {
      if (!snapshot.pilot_input_ref)
        fail(
          'programme_pilot_input_required',
          'Select exact supplied pilot-design inputs before starting a pilot draft.',
        );
      const source = this.host.readArtifact(snapshot.pilot_input_ref, identity);
      let input: PilotInput;
      try {
        input = pilotInputSchema.parse(pilotArtifactContent(source));
      } catch {
        fail(
          'programme_pilot_input_invalid',
          'The selected source must contain the versioned supplied pilot-input JSON contract.',
          422,
        );
      }
      try {
        canonicalJson(input, 65536);
      } catch {
        fail(
          'programme_pilot_input_bound',
          'Pilot design inputs exceed the 64 KiB envelope.',
          422,
        );
      }
      if (
        snapshot.scientific_owner &&
        input.scientific_owner &&
        snapshot.scientific_owner !== input.scientific_owner
      )
        fail(
          'programme_pilot_owner_mismatch',
          'Supplied pilot inputs identify a different scientific owner.',
        );
      try {
        refs.push(snapshot.pilot_input_ref, ...pilotEvidenceReferences(input));
      } catch {
        fail(
          'programme_pilot_context_bound',
          'Pilot evidence exceeds the 64 exact-reference or depth envelope; split explicitly.',
          422,
        );
      }
    }
    return [
      ...new Map(refs.map((item) => [refKey(item), exact(item)])).values(),
    ];
  }
  private accessible(refs: ArtifactRef[], identity: TaskIdentity) {
    for (const ref of refs) {
      this.host.assertEvidenceCurrent(ref, identity);
      const source = this.host.readArtifact(ref, identity);
      if (
        source.id !== ref.id ||
        source.version !== ref.version ||
        source.sha256 !== ref.sha256
      )
        fail(
          'programme_source_mismatch',
          'An exact selected source reference is unavailable.',
        );
    }
  }
  private inputClosure(
    refs: ArtifactRef[],
    identity: TaskIdentity,
    followEmbedded = false,
  ): ArtifactRef[] {
    const seen = new Map<string, ArtifactRef>(),
      visiting = new Set<string>();
    const visit = (ref: ArtifactRef) => {
      if (visiting.has(refKey(ref)))
        fail(
          'programme_context_cycle',
          'Selected evidence has a cyclic artifact dependency.',
          422,
        );
      if (seen.has(refKey(ref))) return;
      if (seen.size + visiting.size >= 64)
        fail(
          'programme_context_bound',
          'Selected evidence exceeds 64 exact references; split the supplied inputs explicitly.',
          422,
        );
      visiting.add(refKey(ref));
      const artifact = this.host.readArtifact(ref, identity);
      for (const dependency of artifact.dependencies) visit(dependency);
      if (followEmbedded) {
        let body: unknown;
        try {
          body = evaluationContent(artifact);
        } catch {
          body = null;
        }
        for (const nested of embeddedEvaluationReferences(body)) visit(nested);
      }
      visiting.delete(refKey(ref));
      seen.set(refKey(ref), exact(ref));
    };
    for (const ref of refs) visit(ref);
    return [...seen.values()];
  }
  private canAdmit(
    snapshot: ReductionProgrammeSnapshot,
    attempts: ReductionProgrammeAttempt[],
    phase: ReductionProgrammePhase,
    identity: TaskIdentity,
    reservation?: { model_calls: number; tool_calls: number },
    ignoreActiveRun?: string,
  ) {
    const capacity = programmeCapacity(snapshot, attempts, (taskId) =>
      this.host.readTask(taskId, identity),
    );
    const active = attempts.find(
      (item) => item.id === capacity.active_attempt_id,
    );
    if (active && active.run_id !== ignoreActiveRun)
      fail(
        'programme_phase_active',
        'One programme phase is already active; finish or cancel it before starting another. Pausing retains its reservation.',
      );
    if (!capacity.remaining_runs || !capacity.remaining_attempts[phase])
      fail(
        'programme_attempt_limit',
        'The programme run or per-phase attempt limit is exhausted.',
      );
    if (
      reservation &&
      (reservation.model_calls > capacity.remaining_model_calls ||
        reservation.tool_calls > capacity.remaining_tool_calls)
    )
      fail(
        'programme_budget_exhausted',
        'Remaining programme capacity cannot reserve this run’s admitted model/tool maxima.',
      );
  }
  startPhase(
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ): ReductionProgrammeMutationReceipt {
    const request = parse(reductionProgrammePhaseRequestSchema, value),
      scope = this.scope(identity),
      operation = `${id}:phase:${key}`,
      hash = contractHash(request);
    return this.host.atomic(() => {
      const receipt = this.repository.receipt(scope, operation, hash);
      if (receipt) return receipt;
      const previous = this.repository.get(scope, id);
      this.expected(previous, request.expected_revision);
      const attempts = this.repository.attempts(scope, id);
      this.canAdmit(previous, attempts, request.phase, identity);
      let assessmentId: string | null = null;
      let planningId: string | null = null;
      let pilotScope: unknown;
      let refs = this.selectedRefs(previous, request.phase, identity);
      // The predecessor's checked outputs are programme lineage, not fresh
      // factual context. This run independently reconstructs the same originals.
      let taskRefs = [...refs];
      if (
        request.planning_attempt_id &&
        !['pilot', 'evaluation'].includes(request.phase)
      )
        fail(
          'programme_phase_input',
          'Only pilot drafts select a planning attempt.',
          400,
        );
      if (request.phase === 'planning') {
        const view = this.read(id, identity);
        const assessment = request.assessment_attempt_id
          ? view.attempts.find(
              (item) => item.attempt.id === request.assessment_attempt_id,
            )
          : view.attempts.findLast(
              (item) => item.attempt.phase === 'assessment',
            );
        if (
          !assessment ||
          assessment.attempt.phase !== 'assessment' ||
          assessment.currency !== 'current' ||
          assessment.execution_status !== 'completed' ||
          !assessment.preview ||
          assessment.preview.state !== 'current' ||
          !assessment.preview.assessment ||
          !assessment.preview.arithmetic_review
        )
          fail(
            'programme_assessment_required',
            'Planning requires an explicitly selected current completed assessment and its exact independent review.',
          );
        assessmentId = assessment.attempt.id;
        refs.push(
          assessment.preview.assessment.artifact,
          assessment.preview.arithmetic_review.artifact,
        );
      } else if (request.phase === 'pilot') {
        if (!request.planning_attempt_id)
          fail(
            'programme_plan_required',
            'Explicitly select a current reviewed planning attempt before drafting a pilot.',
          );
        const view = this.read(id, identity);
        const planning = view.attempts.find(
          (item) =>
            item.attempt.id === request.planning_attempt_id &&
            item.attempt.phase === 'planning',
        );
        const assessment = view.attempts.find(
          (item) => item.attempt.id === planning?.attempt.assessment_attempt_id,
        );
        if (
          !planning ||
          planning.currency !== 'current' ||
          planning.execution_status !== 'completed' ||
          planning.preview?.state !== 'current' ||
          !planning.preview.plan ||
          planning.preview.plan_review?.value.verdict !== 'supported' ||
          !assessment ||
          assessment.currency !== 'current' ||
          assessment.preview?.state !== 'current' ||
          !assessment.preview.selection ||
          !assessment.preview.assessment ||
          assessment.preview.arithmetic_review?.value.verdict !== 'supported'
        )
          fail(
            'programme_plan_required',
            'Pilot drafting requires the exact current completed assessment, conditional plan and independent reviews.',
          );
        if (
          request.assessment_attempt_id &&
          request.assessment_attempt_id !== assessment.attempt.id
        )
          fail(
            'programme_phase_input',
            'The selected assessment differs from the exact planning dependency.',
            400,
          );
        assessmentId = assessment.attempt.id;
        planningId = planning.attempt.id;
        refs.push(
          assessment.preview.selection.artifact,
          assessment.preview.assessment.artifact,
          assessment.preview.arithmetic_review.artifact,
          planning.preview.plan.artifact,
          planning.preview.plan_review.artifact,
        );
        taskRefs = this.inputClosure(refs, identity);
        refs = [...taskRefs];
        pilotScope = pilotRequestSchema.parse({
          schema_version: 'haze.reduction.pilot-request.v1',
          programme_id: id,
          preview: previous.preview,
          input_ref: previous.pilot_input_ref,
          scientific_owner: previous.scientific_owner,
          selection_ref: assessment.preview.selection.artifact,
          assessment_ref: assessment.preview.assessment.artifact,
          arithmetic_review_ref: assessment.preview.arithmetic_review.artifact,
          plan_ref: planning.preview.plan.artifact,
          plan_review_ref: planning.preview.plan_review.artifact,
        });
      } else if (request.phase === 'evaluation') {
        if (!previous.evaluation_input_ref || !request.registration_id)
          fail(
            'programme_registration_required',
            'Evaluation requires selected exact inputs and an explicit retained registration ID.',
          );
        const view = this.read(id, identity);
        const planning = view.attempts.findLast(
          (item) =>
            item.attempt.phase === 'planning' &&
            item.currency === 'current' &&
            item.preview?.state === 'current',
        );
        const assessment = view.attempts.find(
          (item) =>
            item.attempt.id === planning?.attempt.assessment_attempt_id &&
            item.currency === 'current' &&
            item.preview?.state === 'current',
        );
        if (!planning || !assessment)
          fail(
            'programme_plan_required',
            'Evaluation requires the current reviewed assessment and planning lineage of this programme.',
          );
        if (
          (request.assessment_attempt_id &&
            request.assessment_attempt_id !== assessment.attempt.id) ||
          (request.planning_attempt_id &&
            request.planning_attempt_id !== planning.attempt.id)
        )
          fail(
            'programme_phase_input',
            'Selected evaluation predecessors differ from current programme lineage.',
          );
        assessmentId = assessment.attempt.id;
        planningId = planning.attempt.id;
        // Validate registration ownership and domain facts before admission. Gaps
        // remain reviewable results; a structural cross-programme binding fails.
        deriveEvaluationMethodContext(
          previous,
          this.repository.records(scope, id),
          view,
          this.host,
          identity,
          previous.evaluation_input_ref,
          previous.evaluation_dossier_ref ?? null,
          request.registration_id,
        );
        refs.push(
          ...assessment.historical_artifact_refs,
          ...planning.historical_artifact_refs,
        );
        taskRefs = this.inputClosure(refs, identity, true);
        refs = [...taskRefs];
        pilotScope = evaluationRequestSchema.parse({
          schema_version: 'haze.reduction.evaluation-request.v1',
          programme_id: id,
          input_ref: previous.evaluation_input_ref,
          dossier_ref: previous.evaluation_dossier_ref ?? null,
          registration_id: request.registration_id,
        });
      } else if (request.assessment_attempt_id)
        fail(
          'programme_phase_input',
          'Assessment phases cannot depend on an assessment attempt.',
          400,
        );
      refs = [
        ...new Map(refs.map((item) => [refKey(item), exact(item)])).values(),
      ];
      if (taskRefs.length > 64 || refs.length > 72)
        fail(
          'programme_context_bound',
          'Phase context exceeds 64 references or its exact programme lineage exceeds 72; split the input selection explicitly.',
          422,
        );
      this.accessible(refs, identity);
      const taskRequest = taskRequestSchema.parse({
        schema_version: 'haze.task.request.v3',
        objective:
          request.phase === 'assessment'
            ? 'Assess the supplied residual damage scenario against ordinary management with exact quantities and independent review.'
            : request.phase === 'planning'
              ? 'Prepare a conditional damage reduction planning preview from the exact selected scenario and supplied digital intervention.'
              : request.phase === 'evaluation'
                ? 'Review the supplied external programme evaluation, reproduce exact residual point comparisons, retain scientific dossier and learning without granting scientific authority.'
                : 'Draft design-specific damage reduction pilot feasibility and a protocol for the exact reviewed scenario and digital rules.',
        scope:
          request.phase === 'assessment'
            ? previous.preview.selection
            : request.phase === 'planning'
              ? previous.preview
              : pilotScope,
        context_refs: taskRefs,
        constraints: [
          'No live digital delivery or achieved-reduction claim. Scientific applicability remains unqualified.',
        ],
        desired_deliverables:
          request.phase === 'assessment'
            ? ['Saved exact physical assessment and independent review.']
            : request.phase === 'pilot'
              ? [
                  'Saved design-specific feasibility, conditional protocol, independent review and explicit missing prerequisites. No live digital action.',
                ]
              : request.phase === 'evaluation'
                ? [
                    'Saved external evaluation, independent technical review, scientific dossier completeness and learning.',
                  ]
                : [
                    'Saved conditional plan, explicit prerequisites and independent review.',
                  ],
      });
      const admission = this.host.admitTask(
        taskRequest,
        `programme-phase:${contractHash({ id, operation })}`,
        identity,
      );
      const task = this.host.readTask(admission.task_id, identity);
      const run = task.runs.find((item) => item.id === task.current_run_id)!;
      const reservation = {
        model_calls: run.limits.max_model_calls,
        tool_calls: run.limits.max_tool_calls,
      };
      this.canAdmit(previous, attempts, request.phase, identity, reservation);
      const next = {
        ...previous,
        revision: previous.revision + 1,
        updated_at: new Date().toISOString(),
      };
      this.append(
        scope,
        previous,
        next,
        'phase',
        `Explicit operator start of ${request.phase} phase.`,
        request.phase === 'assessment'
          ? ['planning', 'pilot', 'evaluation']
          : request.phase === 'planning'
            ? ['pilot', 'evaluation']
            : request.phase === 'pilot'
              ? ['evaluation']
              : [],
      );
      const attempt: ReductionProgrammeAttempt = {
        schema_version: 'haze.reduction.programme.attempt.v1',
        id: randomUUID(),
        programme_id: id,
        programme_revision: next.revision,
        phase: request.phase,
        task_id: task.id,
        run_id: run.id,
        objective_revision: task.objective_revision,
        input_fingerprint: programmeInputFingerprint(
          previous,
          request.phase,
          assessmentId,
          planningId,
          this.repository.records(scope, id),
          request.registration_id,
        ),
        selected_refs: refs,
        predecessor_attempt_id:
          attempts.findLast((item) => item.phase === request.phase)?.id ?? null,
        assessment_attempt_id: assessmentId,
        ...(request.phase === 'pilot'
          ? {
              planning_attempt_id: planningId!,
              pilot_input_ref: previous.pilot_input_ref!,
            }
          : {}),
        ...(request.phase === 'evaluation'
          ? {
              planning_attempt_id: planningId!,
              evaluation_input_ref: previous.evaluation_input_ref!,
              evaluation_dossier_ref: previous.evaluation_dossier_ref ?? null,
              registration_id: request.registration_id!,
            }
          : {}),
        reservation,
        created_at: next.updated_at,
      };
      this.repository.bind(scope, attempt);
      return this.saveReceipt(scope, operation, hash, next, 'phase', attempt);
    });
  }
  mutateTask(
    context: ProgrammeTaskMutation,
    perform: () => ControlReceipt,
  ): ControlReceipt {
    const scope = this.scope(context.identity, context.before.mode);
    const bindings = this.repository.bindings(scope, context.before.id);
    if (!bindings.length) return perform();
    if (scope.mode !== this.host.mode)
      return fail(
        'programme_mode_mismatch',
        'Programme-linked tasks can be changed only in their admitted execution mode.',
      );
    return this.host.atomic(() => {
      const operation = `task:${context.before.id}:${context.kind}:${context.key}`,
        hash = contractHash({
          kind: context.kind,
          task_id: context.before.id,
          input: context.input,
        });
      const prior = this.repository.taskMutationReceipt(scope, operation, hash);
      if (prior) return prior;
      const bound = bindings.findLast(
        (item) =>
          item.run_id === context.before.current_run_id &&
          item.objective_revision === context.before.objective_revision,
      );
      const coordination = (
        context.input as TaskControl & { coordination?: ProgrammeCoordination }
      ).coordination;
      const owner = bound ?? bindings.at(-1)!;
      if (coordination && coordination.owner_id !== owner.programme_id)
        fail(
          'programme_owner_mismatch',
          'Task coordination does not identify its bound programme.',
        );
      if (context.kind === 'update')
        fail(
          'programme_bound_update',
          'Revise the programme inputs and explicitly start a replacement phase; a generic correction cannot silently rebind the exact admitted objective.',
        );
      const control = context.input as TaskControl;
      if (['pause', 'cancel', 'revoke'].includes(control.action)) {
        const receipt = perform();
        this.repository.saveTaskMutationReceipt(
          scope,
          operation,
          hash,
          receipt,
        );
        return receipt;
      }
      if (!bound)
        fail(
          'programme_binding_mismatch',
          'The current task run/objective is not the exact programme-bound attempt.',
        );
      const snapshot = this.repository.get(scope, bound.programme_id);
      if (coordination) this.expected(snapshot, coordination.expected_revision);
      const attempts = this.repository.attempts(scope, snapshot.id);
      const view = this.read(snapshot.id, context.identity).attempts.find(
        (item) => item.attempt.id === bound.id,
      );
      if (!view || view.currency !== 'current')
        fail(
          'programme_attempt_stale',
          'Programme inputs or the selected predecessor changed; explicitly admit a replacement phase.',
        );
      this.accessible(bound.selected_refs, context.identity);
      if (control.action === 'resume') {
        const receipt = perform();
        this.repository.saveTaskMutationReceipt(
          scope,
          operation,
          hash,
          receipt,
        );
        return receipt;
      }
      if (!coordination)
        fail(
          'programme_revision_required',
          'Continue requires coordination.owner_id and the current expected programme revision.',
        );
      this.canAdmit(
        snapshot,
        attempts,
        bound.phase,
        context.identity,
        undefined,
        bound.run_id,
      );
      const result = perform();
      const task = this.host.readTask(context.before.id, context.identity);
      if (
        task.current_run_id === bound.run_id ||
        task.objective_revision !== bound.objective_revision
      )
        fail(
          'programme_successor_mismatch',
          'Continue must create one explicit successor run for the unchanged objective.',
        );
      const run = task.runs.find((item) => item.id === task.current_run_id)!;
      const reservation = {
        model_calls: run.limits.max_model_calls,
        tool_calls: run.limits.max_tool_calls,
      };
      this.canAdmit(
        snapshot,
        attempts,
        bound.phase,
        context.identity,
        reservation,
      );
      this.host.pinTaskInputs(
        task.id,
        ['pilot', 'evaluation'].includes(bound.phase)
          ? bound.selected_refs
          : this.selectedRefs(snapshot, bound.phase, context.identity),
        context.identity,
      );
      const next = {
        ...snapshot,
        revision: snapshot.revision + 1,
        updated_at: new Date().toISOString(),
      };
      this.append(
        scope,
        snapshot,
        next,
        'task_mutation',
        'Explicit coordinated task Continue bound to a new phase attempt.',
        bound.phase === 'assessment'
          ? ['planning', 'pilot', 'evaluation']
          : bound.phase === 'planning'
            ? ['pilot', 'evaluation']
            : bound.phase === 'pilot'
              ? ['evaluation']
              : [],
      );
      this.repository.bind(scope, {
        ...bound,
        id: randomUUID(),
        programme_revision: next.revision,
        run_id: run.id,
        predecessor_attempt_id: bound.id,
        reservation,
        created_at: next.updated_at,
      });
      this.repository.saveTaskMutationReceipt(scope, operation, hash, result);
      return result;
    });
  }
}
export { ReductionProgrammeService as ProgrammeService };
