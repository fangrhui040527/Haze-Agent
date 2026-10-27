import { z } from 'zod';
import { artifactRefSchema } from '../contracts/artifacts.js';
import {
  managerActionSchema,
  managerDecisionSchema,
} from '../contracts/manager.js';

type JsonSchema = z.core.JSONSchema.JSONSchema;

export const MANAGER_REFERENCE_CONTRACT_VERSION = 'haze.manager-references.v1';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function containsReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsReference);
  if (!record(value)) return false;
  return (
    artifactRefSchema.safeParse({
      id: value.id,
      version: value.version,
      sha256: value.sha256,
    }).success || Object.values(value).some(containsReference)
  );
}

/** Absence must be explicit; a partial or compacted context is not proof. */
function explicitlyNoReferences(context: unknown): boolean {
  if (
    !record(context) ||
    !Array.isArray(context.artifacts) ||
    context.artifacts.length !== 0 ||
    !record(context.request) ||
    !Array.isArray(context.request.context_refs) ||
    context.request.context_refs.length !== 0 ||
    !Array.isArray(context.corrections)
  )
    return false;
  if (
    context.corrections.some(
      (correction) =>
        !record(correction) ||
        (correction.context_refs !== undefined &&
          (!Array.isArray(correction.context_refs) ||
            correction.context_refs.length !== 0)),
    )
  )
    return false;
  for (const key of ['inspections', 'reviews', 'source_applicability']) {
    const value = context[key];
    if (value !== undefined && (!Array.isArray(value) || value.length))
      return false;
  }
  if (record(context.context_status)) {
    const status = context.context_status;
    if (
      status.truncated === true ||
      Number(status.omitted_artifacts ?? 0) > 0 ||
      Number(status.omitted_events ?? 0) > 0 ||
      (Array.isArray(status.missing) && status.missing.length > 0)
    )
      return false;
  }
  return !containsReference(context);
}

/** The complete authority schema also determines the runtime's input reservation. */
export function managerReferenceOutputSchema(baseJSON: JsonSchema): JsonSchema {
  const empty: JsonSchema = { type: 'array', items: {}, maxItems: 0 };
  const policy: JsonSchema = {
    type: 'object',
    properties: {
      references: empty,
      action: {
        anyOf: [
          {
            type: 'object',
            properties: {
              type: {
                enum: managerActionSchema.options
                  .map((option) => option.shape.type.value)
                  .filter((type) => type !== 'finalize'),
              },
            },
            required: ['type'],
          },
          {
            type: 'object',
            properties: {
              type: { const: 'finalize' },
              sources: empty,
              work_products: empty,
            },
            required: ['type'],
          },
        ],
      },
    },
  };
  return {
    ...baseJSON,
    allOf: [...(Array.isArray(baseJSON.allOf) ? baseJSON.allOf : []), policy],
  };
}

/** Add a small authority policy without moving the base document's $ref scope. */
export function createManagerReferenceContract<
  Schema extends z.ZodType = typeof managerDecisionSchema,
>(
  context: unknown,
  baseSchema: Schema = managerDecisionSchema as unknown as Schema,
  baseOutputSchema?: JsonSchema,
) {
  const baseJSON = baseOutputSchema ?? z.toJSONSchema(baseSchema);
  const constrained = explicitlyNoReferences(context);
  const version = MANAGER_REFERENCE_CONTRACT_VERSION;
  if (!constrained)
    return { schema: baseSchema, outputSchema: baseJSON, constrained, version };

  const outputSchema = managerReferenceOutputSchema(baseJSON);
  const schema = baseSchema.superRefine((value: unknown, check) => {
    if (!record(value)) return;
    const positions: [PropertyKey[], unknown][] = [
      [['references'], value.references],
    ];
    if (record(value.action) && value.action.type === 'finalize')
      positions.push(
        [['action', 'sources'], value.action.sources],
        [['action', 'work_products'], value.action.work_products],
      );
    for (const [path, refs] of positions) {
      if (Array.isArray(refs) && refs.length)
        check.addIssue({
          code: 'custom',
          path,
          message:
            'No artifact references are admitted in this context; this array must be empty.',
        });
    }
  });
  return { schema, outputSchema, constrained, version };
}
