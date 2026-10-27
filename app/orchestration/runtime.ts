import {
  TaskError,
  type Assignment,
  type TaskRecord,
} from '../contracts/tasks.js';
import type { Artifact, ArtifactRef } from '../contracts/artifacts.js';
import type { ArtifactReviewCheck } from '../contracts/manager.js';
import type { AssignmentPlan, ExecutionRegistry } from './ports.js';

export function validateAssignmentPlan(
  plan: AssignmentPlan[],
  registry: ExecutionRegistry,
  authorizedCapabilities: Set<string>,
  authorizedTools: Set<string>,
  retained: Assignment[] = [],
): void {
  const keys = new Set<string>();
  for (const item of plan) {
    if (keys.has(item.key))
      throw new TaskError(
        422,
        'duplicate_assignment_key',
        'Assignment keys must be unique.',
      );
    keys.add(item.key);
    const definition = registry.definitions.get(item.definition_id);
    if (
      !definition ||
      definition.agent === 'Manager' ||
      !authorizedCapabilities.has(definition.capability) ||
      !registry.agents.has(definition.agent)
    )
      throw new TaskError(
        403,
        'definition_denied',
        'Assignment definition or capability is not registered and authorized.',
      );
    for (const tool of definition.tools)
      if (!registry.tools.has(tool) || !authorizedTools.has(tool))
        throw new TaskError(
          403,
          'tool_denied',
          'Assignment requests an unregistered or revoked tool.',
        );
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key))
      throw new TaskError(
        422,
        'dependency_cycle',
        'Assignment dependencies must form a DAG.',
      );
    if (visited.has(key)) return;
    const assignment = plan.find((item) => item.key === key);
    if (!assignment) {
      const existing = retained.find((item) => item.id === key);
      if (
        existing &&
        !['failed', 'cancelled', 'stale', 'timed_out'].includes(existing.status)
      ) {
        visiting.add(key);
        for (const dependency of existing.dependencies) visit(dependency);
        visiting.delete(key);
        visited.add(key);
        return;
      }
      throw new TaskError(
        422,
        'missing_prerequisite',
        'An assignment dependency does not exist.',
      );
    }
    visiting.add(key);
    for (const dependency of assignment.depends_on) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of keys) visit(key);
  for (const item of retained) visit(item.id);
  for (const capability of registry.capabilities.values()) {
    for (const requirement of capability.prerequisites ?? []) {
      for (const assignment of plan.filter(
        (item) => item.definition_id === requirement.definition_id,
      )) {
        const dependencyDefinitions = assignment.depends_on.map(
          (key) =>
            plan.find((item) => item.key === key)?.definition_id ??
            retained.find((item) => item.id === key)?.definition_id,
        );
        if (
          requirement.depends_on_definitions.some(
            (id) => !dependencyDefinitions.includes(id),
          )
        )
          throw new TaskError(
            422,
            'missing_prerequisite',
            'The registered deterministic prerequisites are missing.',
          );
      }
    }
    for (const requirement of capability.review_requirements ?? []) {
      const producers = plan.filter((item) => {
        const definition = registry.definitions.get(item.definition_id);
        return (
          definition?.capability === capability.card.id &&
          definition.agent !== 'EvidenceCritic' &&
          (!requirement.producer_definition_ids ||
            requirement.producer_definition_ids.includes(item.definition_id))
        );
      });
      if (
        producers.length &&
        ![...plan, ...retained].some(
          (item) => item.definition_id === requirement.review_definition_id,
        )
      )
        throw new TaskError(
          422,
          'independent_review_required',
          'The plan omits a required independent review assignment.',
        );
    }
  }
}

/** Review is evidence about exact producer revisions, never a completed-status shortcut. */
export function assessArtifactReviews(
  task: TaskRecord,
  registry: ExecutionRegistry,
  artifacts: Artifact[],
): ArtifactReviewCheck[] {
  const current = (artifact: Artifact) =>
    task.artifacts.some(
      (entry) =>
        entry.objective_revision === task.objective_revision &&
        entry.current &&
        entry.artifact.id === artifact.id &&
        entry.artifact.version === artifact.version &&
        entry.artifact.sha256 === artifact.sha256,
    );
  const assignments = task.assignments.filter(
    (item) =>
      item.run_id === task.current_run_id &&
      item.objective_revision === task.objective_revision &&
      !['stale', 'cancelled'].includes(item.status),
  );
  const checks: ArtifactReviewCheck[] = [];
  for (const artifact of artifacts.filter(current)) {
    const producer = assignments.find(
      (item) =>
        item.id === artifact.assignment_id &&
        item.revision === artifact.assignment_revision,
    );
    if (!producer || producer.role === 'EvidenceCritic') continue;
    const capability = registry.capabilities.get(producer.capability);
    const requirement = capability?.review_requirements?.find(
      (item) =>
        item.artifact_kind === artifact.kind &&
        (!item.producer_definition_ids ||
          item.producer_definition_ids.includes(producer.definition_id)),
    );
    if (!requirement && !artifact.external_candidates?.length) continue;
    if (!requirement) {
      checks.push({
        artifact: {
          id: artifact.id,
          version: artifact.version,
          sha256: artifact.sha256,
        },
        producer_assignment_id: producer.id,
        producer_revision: producer.revision,
        verdict: 'needs_review',
        limitations: [
          'This work product consumed an unreviewed external candidate and has no registered independent review requirement for its exact artifact kind.',
        ],
      });
      continue;
    }
    let accepted: ArtifactReviewCheck | undefined;
    for (const review of artifacts.filter(current)) {
      const reviewer = assignments.find(
        (item) =>
          item.id === review.assignment_id &&
          item.revision === review.assignment_revision &&
          item.definition_id === requirement.review_definition_id &&
          item.role === 'EvidenceCritic' &&
          item.status === 'completed',
      );
      if (
        !reviewer ||
        reviewer.id === producer.id ||
        !reviewer.inputs.some(
          (ref) =>
            ref.id === artifact.id &&
            ref.sha256 === artifact.sha256 &&
            ref.version === artifact.version,
        )
      )
        continue;
      const verdict = capability?.normalizeReview?.(review);
      if (
        !verdict ||
        !verdict.artifacts.some(
          (ref) =>
            ref.id === artifact.id &&
            ref.sha256 === artifact.sha256 &&
            ref.version === artifact.version,
        )
      )
        continue;
      accepted = {
        artifact: {
          id: artifact.id,
          version: artifact.version,
          sha256: artifact.sha256,
        },
        producer_assignment_id: producer.id,
        producer_revision: producer.revision,
        reviewer_assignment_id: reviewer.id,
        reviewer_revision: reviewer.revision,
        verdict: verdict.verdict,
        review_artifact: {
          id: review.id,
          version: review.version,
          sha256: review.sha256,
        },
        limitations: verdict.limitations,
      };
      if (verdict.verdict === 'rejected') break;
    }
    checks.push(
      accepted ?? {
        artifact: {
          id: artifact.id,
          version: artifact.version,
          sha256: artifact.sha256,
        },
        producer_assignment_id: producer.id,
        producer_revision: producer.revision,
        verdict: 'needs_review',
        limitations: [
          'The required independent review has not established support for this exact artifact revision.',
        ],
      },
    );
  }
  return checks;
}

/** A selected manifest is supported only when every exact dependency is supported. */
export function validateArtifactClosure(
  task: TaskRecord,
  registry: ExecutionRegistry,
  artifacts: Artifact[],
  selected: ArtifactRef[],
  readArtifact: (ref: ArtifactRef) => Artifact,
  foreignProvenance?: (
    artifact: Artifact,
  ) => { task: TaskRecord; artifacts: Artifact[] } | undefined,
): Artifact[] {
  const checks = assessArtifactReviews(task, registry, artifacts);
  const foreignChecks = new Map<string, ArtifactReviewCheck[]>();
  const closure = new Map<string, Artifact>();
  const visiting = new Set<string>();
  const visit = (ref: ArtifactRef, dependency = false) => {
    // Resolve before deduplication so a conflicting reference to an already seen ID
    // cannot inherit the validation of a different version or hash.
    const artifact = readArtifact(ref);
    if (
      artifact.id !== ref.id ||
      artifact.version !== ref.version ||
      artifact.sha256 !== ref.sha256
    )
      throw new TaskError(
        409,
        'artifact_version_mismatch',
        'An exact final artifact dependency changed.',
      );
    if (visiting.has(ref.id))
      throw new TaskError(
        422,
        'artifact_dependency_cycle',
        'Final artifact dependencies must form a DAG.',
      );
    if (
      !task.artifacts.some(
        (entry) =>
          entry.objective_revision === task.objective_revision &&
          entry.current &&
          entry.artifact.id === ref.id &&
          entry.artifact.version === ref.version &&
          entry.artifact.sha256 === ref.sha256,
      )
    )
      throw new TaskError(
        422,
        'artifact_not_applicable',
        'Final artifacts and their dependencies require current objective applicability.',
      );
    const producerId =
      artifact.assignment_id ??
      (artifact.producer.kind === 'assignment'
        ? artifact.producer.id
        : undefined);
    const provenance =
      artifact.task_id && artifact.task_id !== task.id
        ? foreignProvenance?.(artifact)
        : undefined;
    const producerTask = provenance?.task ?? task;
    if (
      provenance &&
      (producerTask.identity.principal !== task.identity.principal ||
        producerTask.identity.workspace !== task.identity.workspace ||
        producerTask.mode !== task.mode)
    )
      throw new TaskError(
        403,
        'world_mode_mismatch',
        'World Model provenance is outside the current workspace or mode.',
      );
    const producer = producerTask.assignments.find(
      (item) => item.id === producerId,
    );
    if (artifact.external_candidates?.length && !producer)
      throw new TaskError(
        422,
        'independent_review_required',
        'Candidate-derived work requires an exact assignment producer and registered independent review.',
      );
    if (provenance && !foreignChecks.has(producerTask.id))
      foreignChecks.set(
        producerTask.id,
        assessArtifactReviews(producerTask, registry, provenance.artifacts),
      );
    const producerChecks = provenance
      ? foreignChecks.get(producerTask.id)!
      : checks;
    // A registered independent review can support a downstream product. It is
    // never itself selectable as a factual work product or an arbitrary opinion.
    const supportingReview =
      dependency &&
      producer?.role === 'EvidenceCritic' &&
      producerChecks.some(
        (check) =>
          check.verdict === 'supported' &&
          check.reviewer_assignment_id === producer.id &&
          check.reviewer_revision === producer.revision &&
          check.review_artifact?.id === ref.id &&
          check.review_artifact.version === ref.version &&
          check.review_artifact.sha256 === ref.sha256,
      );
    if (
      producerId &&
      (!producer ||
        producer.run_id !== producerTask.current_run_id ||
        producer.objective_revision !== producerTask.objective_revision ||
        producer.revision !== artifact.assignment_revision ||
        (producer.status !== 'completed' &&
          !(producer.role === 'Manager' && producer.status === 'running')) ||
        ['rejected', 'stale'].includes(producer.usability) ||
        (producer.role === 'EvidenceCritic' && !supportingReview))
    )
      throw new TaskError(
        422,
        'unsupported_final_reference',
        'Final artifacts and their dependencies require completed current producer revisions.',
      );
    const review = producerChecks.find(
      (item) =>
        item.artifact.id === ref.id &&
        item.artifact.version === ref.version &&
        item.artifact.sha256 === ref.sha256,
    );
    if (review && review.verdict !== 'supported')
      throw new TaskError(
        422,
        'independent_review_required',
        'Required review does not support the exact final artifact closure.',
      );
    if (closure.has(ref.id)) return;
    visiting.add(ref.id);
    for (const dependencyRef of artifact.dependencies)
      visit(dependencyRef, true);
    visiting.delete(ref.id);
    closure.set(ref.id, artifact);
  };
  for (const ref of selected) visit(ref);
  return [...closure.values()];
}
