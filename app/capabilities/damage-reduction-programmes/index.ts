import { z } from 'zod';
import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import type { ArtifactReviewCheck } from '../../contracts/manager.js';
import { contractHash } from '../../contracts/json.js';
import { reductionPreviewViewSchema } from '../../contracts/damage-reduction-view.js';
import { pilotTaskViewSchema } from '../../contracts/damage-reduction-pilot.js';
import { evaluationTaskViewSchema } from '../../contracts/damage-reduction-evaluation.js';
import {
  createEvaluationTools,
  readEvaluationTaskView,
} from '../damage-reduction-planning/evaluation-workflow.js';
import {
  TaskError,
  type TaskIdentity,
  type TaskRecord,
} from '../../contracts/tasks.js';
import type {
  TaskRuntimeExtension,
  TaskRuntimeExtensionHost,
} from '../../orchestration/ports.js';
import { ReductionProgrammeRepository } from './repository.js';
import { ReductionProgrammeService } from './service.js';

const prefix = '/api/reduction-programmes';
const keyOf = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;

type EvidenceReadCache = {
  checked: Set<string>;
  edges: Map<string, string[]>;
  ownerReviews: Map<string, ArtifactReviewCheck[]>;
  tasks: Map<string, TaskRecord>;
  artifacts: Map<string, Artifact>;
};
type ProgrammeEvidenceHost = Pick<
  TaskRuntimeExtensionHost,
  'mode' | 'readArtifact' | 'readTask' | 'artifactReviews'
> & {
  store: {
    world: Pick<
      TaskRuntimeExtensionHost['store']['world'],
      'lookup' | 'activeHolds'
    >;
  };
};
/** No read authority is cached beyond one synchronous outer service operation. */
export function createProgrammeEvidenceReadBoundary(
  host: ProgrammeEvidenceHost,
) {
  let boundary: Map<string, EvidenceReadCache> | null = null;
  const freshCache = (): EvidenceReadCache => ({
    checked: new Set(),
    edges: new Map(),
    ownerReviews: new Map(),
    tasks: new Map(),
    artifacts: new Map(),
  });
  const cacheFor = (identity: TaskIdentity) => {
    if (boundary === null) return undefined;
    const scope = JSON.stringify([
      host.mode,
      identity.principal,
      identity.workspace,
    ]);
    let value = boundary.get(scope);
    if (!value) {
      value = freshCache();
      boundary.set(scope, value);
    }
    return value;
  };
  const withEvidenceRead = <T>(operation: () => T): T => {
    if (boundary !== null) return operation();
    boundary = new Map();
    try {
      return operation();
    } finally {
      boundary = null;
    }
  };
  const readArtifact = (ref: ArtifactRef, identity: TaskIdentity): Artifact => {
    const cache = cacheFor(identity);
    const saved = cache?.artifacts.get(keyOf(ref));
    if (saved) return saved;
    const artifact = host.readArtifact(ref, identity);
    cache?.artifacts.set(keyOf(ref), artifact);
    return artifact;
  };
  const readTask = (id: string, identity: TaskIdentity): TaskRecord => {
    const cache = cacheFor(identity);
    const saved = cache?.tasks.get(id);
    if (saved) return saved;
    const task = host.readTask(id, identity);
    cache?.tasks.set(id, task);
    return task;
  };
  const assertEvidenceCurrent = (ref: ArtifactRef, identity: TaskIdentity) => {
    const cache = cacheFor(identity) ?? freshCache();
    const { checked, ownerReviews, edges } = cache;
    const visiting = new Set<string>(),
      rootSeen = new Set<string>();
    const countCached = (key: string): void => {
      if (rootSeen.has(key)) return;
      rootSeen.add(key);
      if (rootSeen.size > 256)
        throw new TaskError(
          409,
          'programme_source_bound',
          'Selected evidence has an oversized dependency closure.',
        );
      for (const child of edges.get(key) ?? []) countCached(child);
    };
    const visit = (selected: ArtifactRef): void => {
      const key = keyOf(selected);
      if (visiting.has(key))
        throw new TaskError(
          409,
          'programme_source_bound',
          'Selected evidence has a cyclic or oversized dependency closure.',
        );
      if (checked.has(key)) {
        countCached(key);
        return;
      }
      rootSeen.add(key);
      if (rootSeen.size > 256)
        throw new TaskError(
          409,
          'programme_source_bound',
          'Selected evidence has an oversized dependency closure.',
        );
      const artifact = readArtifact(selected, identity);
      const supportingReviews: ArtifactRef[] = [];
      if (
        keyOf(artifact) !== key ||
        contractHash(artifact.content) !== selected.sha256
      )
        throw new TaskError(
          409,
          'programme_source_mismatch',
          'Selected evidence does not match its exact immutable reference.',
        );
      const scope = { ...identity, mode: host.mode };
      const records = host.store.world.lookup(scope, {
        kind: 'artifact_reference',
        external_id: `artifact:${artifact.id}:${artifact.version}`,
        limit: 2,
      });
      if (
        records.length > 1 ||
        records.some(
          (record) => host.store.world.activeHolds(scope, record.ref.id).length,
        )
      )
        throw new TaskError(
          409,
          'programme_source_held',
          'Selected evidence is held, withdrawn or ambiguous.',
        );
      if (artifact.task_id) {
        const owner = readTask(artifact.task_id, identity);
        const producerId =
          artifact.assignment_id ??
          (artifact.producer.kind === 'assignment'
            ? artifact.producer.id
            : undefined);
        const producer = producerId
          ? owner.assignments.find((item) => item.id === producerId)
          : undefined;
        const pilotProducer =
          artifact.kind === 'reduction.evaluation-review'
            ? {
                role: 'EvidenceCritic',
                definition: 'reduction.evaluation-check',
              }
            : [
                  'reduction.external-evaluation',
                  'reduction.evaluation-learning',
                ].includes(artifact.kind)
              ? { role: 'DamageAccountant', definition: 'reduction.evaluate' }
              : artifact.kind === 'reduction.pilot-review'
                ? {
                    role: 'EvidenceCritic',
                    definition: 'reduction.pilot-check',
                  }
                : [
                      'reduction.pilot-feasibility',
                      'reduction.pilot-protocol',
                    ].includes(artifact.kind)
                  ? {
                      role: 'WorkerShield',
                      definition: 'reduction.pilot-draft',
                    }
                  : null;
        if (
          pilotProducer &&
          (!producer ||
            producer.role !== pilotProducer.role ||
            producer.definition_id !== pilotProducer.definition ||
            producer.definition_version !== '1' ||
            artifact.producer.kind !== 'assignment' ||
            artifact.producer.id !== producer.id ||
            !producer.outputs.some((output) => keyOf(output) === key))
        )
          throw new TaskError(
            409,
            'programme_pilot_producer',
            'Pilot products require their exact registered producer and independent reviewer outputs.',
          );
        if (
          owner.mode !== host.mode ||
          artifact.run_id !== owner.current_run_id ||
          artifact.objective_revision !== owner.objective_revision ||
          !owner.artifacts.some(
            (entry) =>
              entry.current &&
              entry.objective_revision === owner.objective_revision &&
              keyOf(entry.artifact) === key,
          ) ||
          artifact.required_tools.some(
            (tool) => !owner.permissions.tools.includes(tool),
          ) ||
          (producerId &&
            (!producer ||
              producer.run_id !== owner.current_run_id ||
              producer.objective_revision !== owner.objective_revision ||
              producer.revision !== artifact.assignment_revision ||
              producer.status !== 'completed' ||
              ['stale', 'rejected'].includes(producer.usability)))
        )
          throw new TaskError(
            409,
            'programme_source_stale',
            'Selected task evidence is stale or its required permission was revoked.',
          );
        let reviews = ownerReviews.get(owner.id);
        if (!reviews) {
          reviews = host.artifactReviews(owner.id, identity);
          ownerReviews.set(owner.id, reviews);
        }
        const productReview = reviews.find(
          (check) => keyOf(check.artifact) === key,
        );
        if (productReview) {
          if (
            productReview.verdict !== 'supported' ||
            !productReview.review_artifact ||
            !productReview.reviewer_assignment_id ||
            productReview.producer_assignment_id !== producerId
          )
            throw new TaskError(
              409,
              'programme_source_review_required',
              'Selected generated evidence lacks a current supported independent review for this exact product revision.',
            );
          supportingReviews.push(productReview.review_artifact);
        }
      }
      edges.set(
        key,
        [...artifact.dependencies, ...supportingReviews].map(keyOf),
      );
      visiting.add(key);
      for (const dependency of artifact.dependencies) visit(dependency);
      visiting.delete(key);
      checked.add(key);
      // Independent reviews necessarily refer back to the product they review.
      // Validate their ordinary DAG after marking that product checked, while a
      // shared review already being validated can cover several component nodes.
      for (const review of supportingReviews)
        if (!visiting.has(keyOf(review))) visit(review);
    };
    try {
      visit(ref);
    } catch (error) {
      // Products are temporarily marked checked before their independent
      // review backedges resolve. No partial validation may survive failure.
      checked.clear();
      edges.clear();
      throw error;
    }
  };

  return { withEvidenceRead, readArtifact, readTask, assertEvidenceCurrent };
}

/** Composition supplies generic runtime boundaries; this module owns domain policy. */
export function createReductionProgrammeExtension(
  host: TaskRuntimeExtensionHost,
): TaskRuntimeExtension {
  const { withEvidenceRead, readArtifact, readTask, assertEvidenceCurrent } =
    createProgrammeEvidenceReadBoundary(host);
  const service = new ReductionProgrammeService(
    new ReductionProgrammeRepository(host.store.db),
    {
      ...host,
      withEvidenceRead,
      readArtifact,
      readTask,
      assertEvidenceCurrent,
      pinTaskInputs(taskId, refs, identity) {
        const pinned = new Set<string>();
        const pin = (ref: ArtifactRef): void => {
          if (pinned.has(keyOf(ref))) return;
          if (pinned.size >= 256)
            throw new TaskError(
              409,
              'programme_source_bound',
              'Selected evidence has an oversized dependency closure.',
            );
          pinned.add(keyOf(ref));
          const artifact = host.readArtifact(ref, identity);
          for (const dependency of artifact.dependencies) pin(dependency);
          host.store.recordApplicability(
            taskId,
            identity,
            ref,
            true,
            'Exact programme-scoped inputs revalidated before bound successor.',
            'programme-coordinator',
          );
        };
        for (const ref of refs) {
          assertEvidenceCurrent(ref, identity);
          pin(ref);
        }
      },
      previewView: (id, identity) =>
        reductionPreviewViewSchema.parse(
          host.readView(id, 'reduction-preview', identity),
        ),
      pilotView: (id, identity) =>
        pilotTaskViewSchema.parse(
          host.readView(id, 'reduction-pilot', identity),
        ),
      evaluationView: (id, identity) =>
        evaluationTaskViewSchema.parse(
          host.readView(id, 'reduction-evaluation', identity),
        ),
    },
  );
  const page = (query: URLSearchParams) => {
    if (
      [...query.keys()].some((key) => !['limit', 'offset'].includes(key)) ||
      ['limit', 'offset'].some((key) => query.getAll(key).length > 1)
    )
      throw new TaskError(
        400,
        'invalid_programme_pagination',
        'Use one limit and offset parameter.',
      );
    const number = (key: string, fallback: number) => {
      const value = query.get(key);
      if (value === null) return fallback;
      if (!/^(0|[1-9]\d*)$/.test(value))
        throw new TaskError(
          400,
          'invalid_programme_pagination',
          'Pagination requires bounded integer values.',
        );
      return Number(value);
    };
    return { limit: number('limit', 10), offset: number('offset', 0) };
  };
  return {
    id: 'reduction-programmes',
    tools: createEvaluationTools(host.store, host.mode, (id, identity) =>
      service.evaluationContext(id, identity),
    ),
    taskViews: {
      'reduction-evaluation': (id: string, identity: TaskIdentity) =>
        readEvaluationTaskView(
          host.store,
          id,
          identity,
          (taskId, taskIdentity) =>
            service.evaluationContext(taskId, taskIdentity),
        ),
    },
    service,
    handlesHttp: (path) => path === prefix || path.startsWith(`${prefix}/`),
    mutateTask: (context, perform) => service.mutateTask(context, perform),
    handleHttp(request) {
      const { method, pathname, query, identity, body } = request;
      const segments = pathname.slice(prefix.length).split('/').filter(Boolean);
      if (
        segments.length > 2 ||
        (segments[0] && !z.uuid().safeParse(segments[0]).success)
      )
        throw new TaskError(
          404,
          'programme_route_not_found',
          'Programme API route not found.',
        );
      const id = segments[0];
      const action = segments[1];
      const methods = !id
        ? ['GET', 'POST']
        : !action || action === 'history'
          ? ['GET']
          : ['revisions', 'phases', 'records'].includes(action)
            ? ['POST']
            : [];
      if (!methods.length)
        throw new TaskError(
          404,
          'programme_route_not_found',
          'Programme API route not found.',
        );
      if (!methods.includes(method))
        throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
      if (query.size && (method !== 'GET' || (id && action !== 'history')))
        throw new TaskError(
          400,
          'invalid_programme_query',
          'Unsupported programme query parameters.',
        );
      if (method === 'GET') {
        if (!id)
          return { status: 200, body: service.list(identity, page(query)) };
        if (action === 'history')
          return {
            status: 200,
            body: service.history(id, identity, page(query)),
          };
        if (!action && !query.size)
          return { status: 200, body: service.read(id, identity) };
      } else if (method === 'POST' && !query.size) {
        if (!request.key)
          throw new TaskError(
            400,
            'idempotency_key_required',
            'Programme mutations require an idempotency key.',
          );
        if (!id)
          return {
            status: 201,
            body: service.create(body, request.key, identity),
          };
        if (action === 'revisions')
          return {
            status: 200,
            body: service.revise(id, body, request.key, identity),
          };
        if (action === 'phases')
          return {
            status: 202,
            body: service.startPhase(id, body, request.key, identity),
          };
        if (action === 'records')
          return {
            status: 200,
            body: service.appendRecord(id, body, request.key, identity),
          };
      }
      throw new TaskError(
        404,
        'programme_route_not_found',
        'Programme API route not found.',
      );
    },
  };
}
