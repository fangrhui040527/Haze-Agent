import { z } from 'zod';
import { identifierSchema, referenceSchema } from '../contracts/common.js';
import {
  planningSchema,
  planningShape,
  runSchema,
} from '../contracts/planning.js';
import { resultSchema } from '../contracts/result.js';

/** Transport only; these are the existing planning/run/result domain contracts. */
export const demoChatSampleSchema = z.strictObject({ request: runSchema });
export const demoChatAcceptedSchema = z.strictObject({
  run_id: identifierSchema,
  status_url: z
    .string()
    .regex(/^\/api\/demo\/crew-scheduling\/runs\/[A-Za-z0-9:_-]+$/),
});
export const demoChatPlanSchema = z.strictObject({
  ref: referenceSchema,
  plan_id: identifierSchema,
  assignments: planningShape.shape.baseline.shape.assignments,
});

const sameRef = (
  left: z.infer<typeof referenceSchema>,
  right: z.infer<typeof referenceSchema>,
) =>
  left.id === right.id &&
  left.revision === right.revision &&
  left.sha256 === right.sha256;

/** Browser-safe validation: deliberately does not import the Node hashing entrypoint. */
export const demoChatResponseSchema = z
  .strictObject({
    schema_version: z.literal('haze.demo_chat.v1'),
    result: resultSchema,
    planning: planningSchema,
    plans: z.array(demoChatPlanSchema).min(1).max(3),
  })
  .superRefine((response, context) => {
    const { result, planning, plans } = response;
    const fail = (message: string) =>
      context.addIssue({ code: 'custom', message });
    if (
      result.execution_surface !== 'historical_harness' ||
      result.input_origin !== 'synthetic_fixture' ||
      planning.input_origin !== 'synthetic_fixture' ||
      result.result.publication_status !== 'publication_disabled' ||
      result.result.recommendation_eligible
    ) {
      fail(
        'The demo transport only accepts fictional, publication-disabled historical results',
      );
    }
    if (
      result.programme_id !== planning.programme_id ||
      result.problem_id !== planning.problem_id
    ) {
      fail('The result must refer to the displayed planning problem');
    }
    if (
      new Set(plans.map((plan) => plan.plan_id)).size !== plans.length ||
      new Set(plans.map((plan) => plan.ref.id)).size !== plans.length
    ) {
      fail('Plan IDs and references must be unique');
    }
    const baseline = plans.find((plan) =>
      sameRef(plan.ref, planning.baseline.ref),
    );
    if (
      !baseline ||
      JSON.stringify(baseline.assignments) !==
        JSON.stringify(planning.baseline.assignments)
    ) {
      fail('The displayed baseline must match the planning bundle');
    }
    if (
      result.result.baseline_ref &&
      !sameRef(result.result.baseline_ref, planning.baseline.ref)
    ) {
      fail(
        'The quantified baseline must match the displayed planning baseline',
      );
    }
    for (const ref of [
      result.result.baseline_ref,
      result.result.selected_plan_ref,
      result.result.comparison_plan_ref,
    ]) {
      if (ref && !plans.some((plan) => sameRef(plan.ref, ref)))
        fail('A result plan is missing from the transport');
    }
    for (const plan of plans) {
      if (!plan.ref.id.startsWith('demo:'))
        fail('Plans must use demo-local references');
      if (
        !planningSchema.safeParse({
          ...planning,
          baseline: { ...planning.baseline, assignments: plan.assignments },
        }).success
      ) {
        fail('A displayed plan violates the shared scheduling contract');
      }
    }
  });

export type DemoChatSample = z.infer<typeof demoChatSampleSchema>;
export type DemoChatAccepted = z.infer<typeof demoChatAcceptedSchema>;
export type DemoChatResponse = z.infer<typeof demoChatResponseSchema>;
