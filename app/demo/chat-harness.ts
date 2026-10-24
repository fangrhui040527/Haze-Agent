import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { contractHash, canonicalJson } from '../contracts/json.js';
import { planningSchema, runSchema } from '../contracts/planning.js';
import type { RunRequest } from '../contracts/planning.js';
import type { ImmutableReference } from '../contracts/common.js';
import {
  generateDemoReviewPackage,
  validateDemoReviewPackage,
} from './review-trace.js';
import { demoChatPlanSchema, demoChatResponseSchema } from './chat-contract.js';
import type {
  DemoChatAccepted,
  DemoChatResponse,
  DemoChatSample,
} from './chat-contract.js';

export type DemoChatCase = 'named-set' | 'missing-evidence';
export class DemoChatError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const artifactSchema = z.object({
  plan_id: demoChatPlanSchema.shape.plan_id,
  assignments: demoChatPlanSchema.shape.assignments,
});
const sameRef = (left: ImmutableReference, right: ImmutableReference) =>
  left.id === right.id &&
  left.revision === right.revision &&
  left.sha256 === right.sha256;
let lastGenerationTime = 0;

/** Local fixture adapter; never admits a public /run or grants canonical capability. */
export function createDemoChatHarness(options: { maxRuns?: number } = {}) {
  const maxRuns = options.maxRuns ?? 32;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 128)
    throw new Error('invalid_run_capacity');
  // A private generation identity prevents stale references from a prior handler being admitted.
  lastGenerationTime = Math.max(Date.now(), lastGenerationTime + 1);
  const recordedAt = new Date(lastGenerationTime).toISOString();
  let prepared: ReturnType<typeof generateDemoReviewPackage> | undefined;
  const runs = new Map<string, { bytes: string; hash: string }>();
  const packageValue = () => {
    if (!prepared) {
      prepared = generateDemoReviewPackage(recordedAt);
      validateDemoReviewPackage(prepared);
    }
    return prepared;
  };
  const requestFor = (kind: DemoChatCase): RunRequest => {
    const value = packageValue();
    return kind === 'named-set'
      ? value.requests.named_set
      : value.requests.missing_evidence;
  };
  return {
    sample(kind: DemoChatCase = 'named-set'): DemoChatSample {
      return { request: structuredClone(requestFor(kind)) };
    },
    run(input: unknown): DemoChatAccepted {
      const startedAt = new Date().toISOString();
      const started = performance.now();
      const parsed = runSchema.safeParse(input);
      if (!parsed.success)
        throw new DemoChatError(
          400,
          'invalid_run_contract',
          'The request does not satisfy haze.run.v2.',
          parsed.error.issues,
        );
      const request = parsed.data;
      const kind = (['named-set', 'missing-evidence'] as const).find(
        (candidate) => {
          const sample = requestFor(candidate);
          return (
            request.programme_id === sample.programme_id &&
            request.input.problem_id === sample.input.problem_id &&
            sameRef(request.input.bundle_ref, sample.input.bundle_ref)
          );
        },
      );
      if (!kind)
        throw new DemoChatError(
          409,
          'unknown_sample_reference',
          'Load the current fictional sample again; this exact bundle reference is unavailable.',
        );

      // Recompute all source intervals, constraints and independent checks for this request.
      // Query text is explanatory intent and cannot replace accepted fixture facts.
      const computed = generateDemoReviewPackage(recordedAt);
      validateDemoReviewPackage(computed);
      const resolve = (ref: ImmutableReference) => {
        const entry = computed.records.find((record) =>
          sameRef(record.ref, ref),
        );
        if (!entry || contractHash(entry.record) !== ref.sha256)
          throw new Error('demo_record_integrity_failure');
        return entry.record;
      };
      const planning = planningSchema.parse(resolve(request.input.bundle_ref));
      const result = structuredClone(
        kind === 'named-set'
          ? computed.results.named_set
          : computed.results.missing_evidence,
      );
      if (!sameRef(result.decision_ref.bundle_ref, request.input.bundle_ref))
        throw new Error('demo_result_binding_failure');
      const runId = `demo:crew-run-${randomUUID()}`;
      result.run_id = runId;
      result.execution.admission_reason = {
        code: 'local_demo_harness_only',
        explanation:
          'This local HTTP fixture adapter executed arithmetic and validation. No canonical /run was admitted.',
      };
      result.execution.finished_at = new Date().toISOString();
      result.execution.finished_reason = null;
      result.timing.started_at = startedAt;
      result.timing.started_reason = null;
      result.timing.elapsed_ms = Math.round(performance.now() - started);
      result.timing.elapsed_reason = null;
      result.limitations.push(
        'Referenced artifacts preserve the sample preparation clock; response timing measures only this local fixture computation. Chat text does not change the immutable sample inputs.',
      );
      const refs =
        kind === 'named-set'
          ? computed.cases
              .slice(0, 3)
              .map((item) =>
                'plan_ref' in item.planner
                  ? item.planner.plan_ref
                  : planning.baseline.ref,
              )
          : [planning.baseline.ref];
      const plans = refs.map((ref) => ({
        ref,
        ...artifactSchema.parse(resolve(ref)),
      }));
      const response = demoChatResponseSchema.parse({
        schema_version: 'haze.demo_chat.v1',
        result,
        planning,
        plans,
      });
      const bytes = canonicalJson(response);
      runs.set(runId, { bytes, hash: contractHash(response) });
      while (runs.size > maxRuns) runs.delete(runs.keys().next().value!);
      return {
        run_id: runId,
        status_url: `/api/demo/crew-scheduling/runs/${runId}`,
      };
    },
    read(runId: string): DemoChatResponse {
      const stored = runs.get(runId);
      if (!stored)
        throw new DemoChatError(
          404,
          'run_unavailable',
          'This local demo run expired or is unknown; submit the sample again.',
        );
      const response = demoChatResponseSchema.parse(JSON.parse(stored.bytes));
      if (contractHash(response) !== stored.hash)
        throw new Error('demo_run_integrity_failure');
      return response;
    },
  };
}
