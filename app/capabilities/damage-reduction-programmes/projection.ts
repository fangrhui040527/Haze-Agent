import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import {
  reductionProgrammeViewSchema,
  type ReductionProgrammeAttempt,
  type ReductionProgrammeCapacity,
  type ReductionProgrammePhase,
  type ReductionProgrammeRecord,
  type ReductionProgrammeSnapshot,
  type ReductionProgrammeView,
} from '../../contracts/damage-reduction-programme.js';
import type { TaskIdentity, TaskRecord } from '../../contracts/tasks.js';
import { contractHash } from '../../contracts/json.js';
import type { ProgrammeHost } from './ports.js';
import type { PilotRecordContext } from '../../contracts/damage-reduction-pilot.js';
import { projectPilotRecords } from './pilot-records.js';
import {
  evaluationLineageFingerprint,
  projectEvaluationRecords,
} from './evaluation-records.js';

export const terminalProgrammeRun = (status: string) =>
  ['completed', 'failed', 'cancelled', 'timed_out'].includes(status);
export function programmeInputFingerprint(
  snapshot: ReductionProgrammeSnapshot,
  phase: ReductionProgrammePhase,
  assessmentAttemptId: string | null = null,
  planningAttemptId: string | null = null,
  records: readonly ReductionProgrammeRecord[] = [],
  registrationId?: string,
): string {
  return contractHash(
    phase === 'assessment'
      ? { selection: snapshot.preview.selection }
      : phase === 'planning'
        ? {
            selection: snapshot.preview.selection,
            candidate: snapshot.preview.candidate,
            assessment_attempt_id: assessmentAttemptId,
          }
        : {
            selection: snapshot.preview.selection,
            candidate: snapshot.preview.candidate,
            pilot_input_ref: snapshot.pilot_input_ref ?? null,
            pilot_record_revision: snapshot.pilot_record_revision ?? 0,
            scientific_owner: snapshot.scientific_owner,
            assessment_attempt_id: assessmentAttemptId,
            planning_attempt_id: planningAttemptId,
            ...(phase === 'evaluation'
              ? {
                  evaluation_input_ref: snapshot.evaluation_input_ref ?? null,
                  evaluation_dossier_ref:
                    snapshot.evaluation_dossier_ref ?? null,
                  registration_id: registrationId ?? null,
                  delivery_lineage: evaluationLineageFingerprint(
                    records,
                    registrationId,
                  ),
                }
              : {}),
          },
  );
}
export function programmeCapacity(
  snapshot: ReductionProgrammeSnapshot,
  attempts: readonly ReductionProgrammeAttempt[],
  read: (taskId: string) => TaskRecord,
): ReductionProgrammeCapacity {
  let chargedModel = 0,
    chargedTools = 0,
    reservedModel = 0,
    reservedTools = 0;
  let active: string | null = null;
  const runs = new Set<string>();
  for (const attempt of attempts) {
    if (runs.has(attempt.run_id)) continue;
    runs.add(attempt.run_id);
    let model = 0,
      tools = 0,
      terminal = false;
    try {
      const task = read(attempt.task_id);
      const run = task.runs.find((item) => item.id === attempt.run_id);
      if (run) {
        model = run.usage.model_calls;
        tools = run.usage.tool_calls;
        terminal = terminalProgrammeRun(run.status);
      }
    } catch {
      /* Unknown authoritative usage cannot release the reservation. */
    }
    chargedModel += model;
    chargedTools += tools;
    if (!terminal) {
      reservedModel += Math.max(0, attempt.reservation.model_calls - model);
      reservedTools += Math.max(0, attempt.reservation.tool_calls - tools);
      active ??= attempt.id;
    }
  }
  return {
    charged_model_calls: chargedModel,
    charged_tool_calls: chargedTools,
    reserved_model_calls: reservedModel,
    reserved_tool_calls: reservedTools,
    remaining_model_calls: Math.max(
      0,
      snapshot.budget.max_model_calls - chargedModel - reservedModel,
    ),
    remaining_tool_calls: Math.max(
      0,
      snapshot.budget.max_tool_calls - chargedTools - reservedTools,
    ),
    remaining_runs: Math.max(0, snapshot.budget.max_runs - runs.size),
    remaining_attempts: {
      assessment: Math.max(
        0,
        snapshot.budget.max_attempts_per_phase -
          attempts.filter((item) => item.phase === 'assessment').length,
      ),
      planning: Math.max(
        0,
        snapshot.budget.max_attempts_per_phase -
          attempts.filter((item) => item.phase === 'planning').length,
      ),
      pilot: Math.max(
        0,
        snapshot.budget.max_attempts_per_phase -
          attempts.filter((item) => item.phase === 'pilot').length,
      ),
      evaluation: Math.max(
        0,
        snapshot.budget.max_attempts_per_phase -
          attempts.filter((item) => item.phase === 'evaluation').length,
      ),
    },
    active_attempt_id: active,
  };
}
const exact = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
export function buildPilotRecordContext(
  host: ProgrammeHost,
  identity: TaskIdentity,
  views: ReductionProgrammeView['attempts'],
  now = new Date().toISOString(),
): PilotRecordContext {
  const current = views.findLast(
    (view) =>
      view.attempt.phase === 'pilot' &&
      view.currency === 'current' &&
      view.pilot?.state === 'current',
  );
  const draft = current?.pilot;
  const planning = views.findLast(
    (view) =>
      view.attempt.phase === 'planning' &&
      view.currency === 'current' &&
      view.preview?.state === 'current',
  );
  const assessment = views.find(
    (view) =>
      view.attempt.id === planning?.attempt.assessment_attempt_id &&
      view.currency === 'current' &&
      view.preview?.state === 'current',
  );
  // This synchronous read has no persisted cache: a later read rechecks holds,
  // withdrawals and permissions even when the programme revision is unchanged.
  const artifacts = new Map<string, Artifact>();
  const currentRefs = new Set<string>();
  const token = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;
  return {
    identity,
    now,
    readArtifact: (ref) => {
      const saved = artifacts.get(token(ref));
      if (saved) return saved;
      const value = host.readArtifact(ref, identity);
      artifacts.set(token(ref), value);
      return value;
    },
    assertEvidenceCurrent: (ref) => {
      if (currentRefs.has(token(ref))) return;
      host.assertEvidenceCurrent(ref, identity);
      currentRefs.add(token(ref));
    },
    current_lineage:
      planning?.preview?.plan &&
      planning.preview.plan_review &&
      assessment?.preview?.selection &&
      assessment.preview.assessment
        ? {
            selection_ref: assessment.preview.selection.artifact,
            assessment_ref: assessment.preview.assessment.artifact,
            plan_ref: planning.preview.plan.artifact,
            plan_review_ref: planning.preview.plan_review.artifact,
          }
        : null,
    current_draft:
      current && draft?.feasibility && draft.protocol && draft.review
        ? {
            attempt_id: current.attempt.id,
            feasibility: draft.feasibility,
            protocol: draft.protocol,
            review: draft.review,
          }
        : null,
  };
}

/** Rebuilt from exact linked runs and governed evidence on every read. */
export function projectReductionProgramme(
  snapshot: ReductionProgrammeSnapshot,
  attempts: ReductionProgrammeAttempt[],
  records: ReductionProgrammeRecord[],
  host: ProgrammeHost,
  identity: TaskIdentity,
  options: { includeEvaluation?: boolean } = {},
): ReductionProgrammeView {
  const latestAssessment = attempts.findLast(
    (item) => item.phase === 'assessment',
  );
  const latestPlanning = attempts.findLast((item) => item.phase === 'planning');
  const latestPilot = attempts.findLast((item) => item.phase === 'pilot');
  const latestEvaluation = attempts.findLast(
    (item) => item.phase === 'evaluation',
  );
  const views: ReductionProgrammeView['attempts'] = [];
  for (const attempt of attempts) {
    if (options.includeEvaluation === false && attempt.phase === 'evaluation')
      continue;
    const view: ReductionProgrammeView['attempts'][number] = {
      attempt,
      execution_status: 'unavailable',
      currency: 'historical',
      result_status: 'unavailable',
      preview: null,
      historical_artifact_refs: [],
      reasons: [],
    };
    try {
      const task = host.readTask(attempt.task_id, identity);
      if (task.mode !== snapshot.mode)
        throw new Error(
          'Linked task execution mode differs from the programme.',
        );
      const run = task.runs.find((item) => item.id === attempt.run_id);
      if (!run) throw new Error('Exact linked run is unavailable.');
      view.execution_status = run.status;
      const result = host.runResult(
        task.id,
        run.id,
        identity,
        attempt.objective_revision,
      );
      if (result) {
        for (const ref of result.work_products) {
          try {
            const artifact = host.readArtifact(ref, identity);
            if (
              artifact.task_id === task.id &&
              artifact.run_id === run.id &&
              artifact.objective_revision === attempt.objective_revision
            )
              view.historical_artifact_refs.push(exact(artifact));
          } catch {
            view.reasons.push(
              'A saved historical result artifact is no longer accessible for this use.',
            );
          }
        }
      }
      const latest =
        attempt.phase === 'assessment'
          ? latestAssessment
          : attempt.phase === 'planning'
            ? latestPlanning
            : attempt.phase === 'pilot'
              ? latestPilot
              : latestEvaluation;
      if (latest?.id !== attempt.id)
        view.reasons.push(
          'A later explicit attempt supersedes this phase attempt.',
        );
      else if (
        task.current_run_id !== attempt.run_id ||
        task.objective_revision !== attempt.objective_revision ||
        run.objective_revision !== attempt.objective_revision
      )
        view.reasons.push(
          'The exact linked task/run objective is historical; its current run is never substituted.',
        );
      else if (
        attempt.input_fingerprint !==
        programmeInputFingerprint(
          snapshot,
          attempt.phase,
          attempt.phase !== 'assessment'
            ? (latestAssessment?.id ?? null)
            : null,
          ['pilot', 'evaluation'].includes(attempt.phase)
            ? (latestPlanning?.id ?? null)
            : null,
          records,
          attempt.registration_id,
        )
      ) {
        view.currency = 'stale';
        view.reasons.push(
          'Relevant programme inputs or the selected assessment changed.',
        );
      } else {
        view.currency = 'current';
        view.result_status = terminalProgrammeRun(run.status)
          ? 'unavailable'
          : 'pending';
        for (const ref of attempt.selected_refs) {
          host.assertEvidenceCurrent(ref, identity);
          const source = host.readArtifact(ref, identity);
          if (
            source.id !== ref.id ||
            source.version !== ref.version ||
            source.sha256 !== ref.sha256
          )
            throw new Error('An exact admitted source reference changed.');
        }
        if (attempt.phase !== 'assessment') {
          const dependency = views.find(
            (item) => item.attempt.id === attempt.assessment_attempt_id,
          );
          if (
            !dependency ||
            dependency.currency !== 'current' ||
            !dependency.preview ||
            dependency.preview.state !== 'current'
          ) {
            view.currency = 'stale';
            view.reasons.push(
              'The exact selected assessment dependency is no longer current and reviewed.',
            );
          }
        }
        if (attempt.phase === 'pilot' || attempt.phase === 'evaluation') {
          const planning = views.find(
            (item) => item.attempt.id === attempt.planning_attempt_id,
          );
          if (
            !planning ||
            planning.currency !== 'current' ||
            planning.preview?.state !== 'current'
          ) {
            view.currency = 'stale';
            view.reasons.push(
              'The exact selected conditional plan is no longer current and reviewed.',
            );
          }
        }
        if (
          view.currency === 'current' &&
          run.status === 'completed' &&
          result
        ) {
          if (attempt.phase === 'evaluation') {
            if (!host.evaluationView)
              throw new Error('Evaluation task view is unavailable.');
            const evaluation = host.evaluationView(task.id, identity);
            if (
              evaluation.run_id !== attempt.run_id ||
              evaluation.objective_revision !== attempt.objective_revision
            )
              throw new Error(
                'Evaluation task view does not describe the exact admitted run/objective.',
              );
            view.evaluation = evaluation;
            if (['current', 'evidence_gap'].includes(evaluation.state))
              view.result_status =
                evaluation.result?.value.status === 'supported' &&
                evaluation.review?.value.verdict === 'supported'
                  ? 'available'
                  : 'gap';
            else {
              view.currency = 'stale';
              view.result_status = 'unavailable';
              view.reasons.push(...evaluation.reasons);
            }
          } else if (attempt.phase === 'pilot') {
            if (!host.pilotView)
              throw new Error('Pilot task view is unavailable.');
            const pilot = host.pilotView(task.id, identity);
            if (
              pilot.run_id !== attempt.run_id ||
              pilot.objective_revision !== attempt.objective_revision
            )
              throw new Error(
                'Pilot task view does not describe the exact linked run/objective.',
              );
            view.pilot = pilot;
            if (pilot.state !== 'current') {
              view.currency = 'stale';
              view.result_status = 'unavailable';
              view.reasons.push(...pilot.reasons);
            } else
              view.result_status =
                pilot.feasibility && pilot.protocol && pilot.review
                  ? 'available'
                  : 'gap';
          } else {
            const preview = host.previewView(task.id, identity);
            if (
              preview.run_id !== attempt.run_id ||
              preview.objective_revision !== attempt.objective_revision
            )
              throw new Error(
                'Governed task view does not describe the linked run/objective.',
              );
            view.preview = preview;
            if (preview.state !== 'current') {
              view.currency = 'stale';
              view.result_status = 'unavailable';
              view.reasons.push(...preview.reasons);
            } else if (attempt.phase === 'assessment')
              view.result_status =
                preview.assessment?.value.status === 'supported'
                  ? 'available'
                  : 'gap';
            else
              view.result_status =
                preview.plan?.value.state === 'evidence_gap'
                  ? 'gap'
                  : preview.plan &&
                      preview.plan_review?.value.verdict === 'supported'
                    ? 'available'
                    : 'gap';
          }
        }
      }
    } catch (error) {
      view.currency = 'stale';
      view.result_status = 'unavailable';
      view.preview = null;
      view.pilot = null;
      view.evaluation = null;
      view.reasons.push(
        error instanceof Error
          ? error.message
          : 'Linked task or current source evidence is unavailable.',
      );
    }
    if (view.currency !== 'current') {
      view.preview = null;
      view.pilot = null;
      view.evaluation = null;
    }
    views.push(view);
  }
  const base = reductionProgrammeViewSchema.parse({
    schema_version: 'haze.reduction.programme.view.v1',
    programme: snapshot,
    capacity: programmeCapacity(snapshot, attempts, (id) =>
      host.readTask(id, identity),
    ),
    attempts: views,
    records,
    pilot: projectPilotRecords(
      snapshot,
      records,
      buildPilotRecordContext(host, identity, views),
    ),
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
  });
  if (options.includeEvaluation === false) return base;
  const evaluation = projectEvaluationRecords(
    snapshot,
    records,
    base,
    host,
    identity,
  );
  return reductionProgrammeViewSchema.parse({
    ...base,
    evaluation,
    scientific_qualification: evaluation.qualification.status,
    achieved_reduction: evaluation.achieved_reduction,
  });
}
