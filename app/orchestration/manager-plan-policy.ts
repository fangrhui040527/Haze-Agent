import { z } from 'zod';
import { managerAssignmentPlanSchema } from '../contracts/manager.js';

const catalogSchema = z.object({
  assignments: z.array(
    z.object({
      capability: z.string().optional(),
      definition_id: z.string().optional(),
      status: z.string(),
    }),
  ),
  capabilities: z.array(
    z.object({
      card: z.object({ id: z.string() }),
      available: z.boolean().optional(),
      templates: z.array(managerAssignmentPlanSchema).optional(),
    }),
  ),
});
const retainedSchema = z.object({
  assignments: z.array(z.object({ id: z.string(), status: z.string() })),
});

/** Handles name host-supplied plans in this exact context, never canned decisions or results. */
export function managerPlanTemplates(context: unknown) {
  const parsed = catalogSchema.safeParse(context);
  if (!parsed.success) return [];
  return parsed.data.capabilities.flatMap((capability) =>
    capability.available !== false &&
    capability.templates?.length &&
    !parsed.data.assignments.some(
      (assignment) =>
        !['cancelled', 'stale'].includes(assignment.status) &&
        (assignment.capability === capability.card.id ||
          capability.templates?.some(
            (template) => template.definition_id === assignment.definition_id,
          )),
    )
      ? [
          {
            handle: `plan:${capability.card.id}`,
            assignments: capability.templates,
          },
        ]
      : [],
  );
}

export function managerRetainableAssignments(
  context: unknown,
): string[] | null {
  const parsed = retainedSchema.safeParse(context);
  return parsed.success
    ? parsed.data.assignments
        .filter(
          (assignment) =>
            !['failed', 'cancelled', 'stale', 'timed_out'].includes(
              assignment.status,
            ),
        )
        .map((assignment) => assignment.id)
    : null;
}

export function expandManagerPlanTemplate(
  value: unknown,
  templates: ReturnType<typeof managerPlanTemplates>,
): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('action' in value) ||
    typeof value.action !== 'object' ||
    value.action === null ||
    !('type' in value.action) ||
    value.action.type !== 'apply_plan' ||
    !('template' in value.action)
  )
    return value;
  const handles = templates.map((template) => template.handle);
  const parsed = z
    .strictObject({
      type: z.literal('apply_plan'),
      template: handles.length
        ? z.enum(handles as [string, ...string[]])
        : z.never(),
      reason: z.string().min(1).max(4096),
    })
    .safeParse(value.action);
  // Leave an invalid wire action unchanged so the ordinary base contract
  // rejects it with bounded schema feedback; never partially repair it.
  if (!parsed.success) return value;
  const wire = parsed.data;
  const selected = templates.find(
    (template) => template.handle === wire.template,
  )!;
  return {
    ...value,
    action: {
      type: 'apply_plan',
      assignments: structuredClone(selected.assignments),
      retain_assignment_ids: [],
      reason: wire.reason,
    },
  };
}
