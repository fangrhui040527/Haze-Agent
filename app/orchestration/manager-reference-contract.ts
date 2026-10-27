import { z } from 'zod';
import { artifactRefSchema } from '../contracts/artifacts.js';
import {
  managerActionSchema,
  managerDecisionSchema,
} from '../contracts/manager.js';
import {
  managerCoordinationIssue,
  managerPeerPolicy,
} from './manager-peer-policy.js';
import {
  expandManagerPlanTemplate,
  managerPlanTemplates,
  managerRetainableAssignments,
} from './manager-plan-policy.js';

type JsonSchema = z.core.JSONSchema.JSONSchema;

export const MANAGER_REFERENCE_CONTRACT_VERSION = 'haze.manager-references.v1';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function referenceCatalogue(context: unknown) {
  const refs = new Map<string, z.infer<typeof artifactRefSchema>>();
  const add = (value: unknown) => {
    const parsed = artifactRefSchema.safeParse(value);
    if (parsed.success && refs.size < 256)
      refs.set(
        `${parsed.data.id}:${parsed.data.version}:${parsed.data.sha256}`,
        parsed.data,
      );
  };
  if (!record(context)) return [];
  const reviewArtifactIds = new Set(
    Array.isArray(context.reviews)
      ? context.reviews.flatMap((review: unknown) =>
          record(review) &&
          record(review.review_artifact) &&
          typeof review.review_artifact.id === 'string'
            ? [review.review_artifact.id]
            : [],
        )
      : [],
  );
  if (record(context.request) && Array.isArray(context.request.context_refs))
    context.request.context_refs.forEach(add);
  if (Array.isArray(context.corrections))
    for (const correction of context.corrections)
      if (record(correction) && Array.isArray(correction.context_refs))
        correction.context_refs.forEach(add);
  if (Array.isArray(context.artifacts))
    for (const artifact of context.artifacts)
      if (record(artifact)) add(artifact.ref);
  return [...refs.values()].map((ref, index) => {
    const artifact: unknown = Array.isArray(context.artifacts)
      ? context.artifacts.find(
          (item: unknown) =>
            record(item) &&
            record(item.ref) &&
            item.ref.id === ref.id &&
            item.ref.version === ref.version &&
            item.ref.sha256 === ref.sha256,
        )
      : undefined;
    return {
      handle: `ref:${index + 1}`,
      ref,
      ...(reviewArtifactIds.has(ref.id) ? { support_only: true as const } : {}),
      ...(record(artifact) && typeof artifact.kind === 'string'
        ? { kind: artifact.kind }
        : {}),
    };
  });
}

function exactReferenceShape(schema: unknown): boolean {
  if (
    !record(schema) ||
    !record(schema.properties) ||
    !Array.isArray(schema.required)
  )
    return false;
  const properties = schema.properties;
  const required = schema.required;
  return (
    Object.keys(properties).length === 3 &&
    ['id', 'version', 'sha256'].every(
      (key) => key in properties && required.includes(key),
    )
  );
}

/** Wire refs are a choice among pinned refs; full canonical refs remain parser-compatible. */
function referenceHandleOutputSchema(
  schema: JsonSchema,
  catalogue: ReturnType<typeof referenceCatalogue>,
): JsonSchema {
  const handles = catalogue.map((entry) => entry.handle);
  const factualHandles = catalogue
    .filter((entry) => !entry.support_only)
    .map((entry) => entry.handle);
  const visit = (value: unknown): unknown => {
    if (exactReferenceShape(value)) return { type: 'string', enum: handles };
    if (Array.isArray(value)) return value.map(visit);
    if (record(value)) {
      const finalize =
        record(value.properties) &&
        record(value.properties.type) &&
        (value.properties.type.const === 'finalize' ||
          (Array.isArray(value.properties.type.enum) &&
            value.properties.type.enum.length === 1 &&
            value.properties.type.enum[0] === 'finalize'));
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
          if (key === 'properties' && finalize && record(child))
            return [
              key,
              Object.fromEntries(
                Object.entries(child).map(([field, property]) => {
                  const transformed = visit(property);
                  return [
                    field,
                    ['sources', 'work_products'].includes(field) &&
                    record(transformed)
                      ? {
                          ...transformed,
                          items: factualHandles.length
                            ? { type: 'string', enum: factualHandles }
                            : {},
                          ...(factualHandles.length ? {} : { maxItems: 0 }),
                        }
                      : field === 'answer' &&
                          record(transformed) &&
                          transformed.type === 'string'
                        ? {
                            ...transformed,
                            description:
                              'Cite selected action.sources in this answer with [ref:N] using their exact reference_catalog handles. Cite only selected sources; the runtime renders their canonical source citation numbers. Do not derive S/E numbers from catalog ordinals.',
                          }
                        : transformed,
                  ];
                }),
              ),
            ];
          const result = visit(child);
          return [
            key,
            key === 'answer' && record(result) && result.type === 'string'
              ? {
                  ...result,
                  description:
                    'Cite selected action.sources in this answer with [ref:N] using their exact reference_catalog handles. Cite only selected sources; the runtime renders their canonical source citation numbers. Do not derive S/E numbers from catalog ordinals.',
                }
              : result,
          ];
        }),
      );
    }
    return value;
  };
  return visit(schema) as JsonSchema;
}

/** Resolve only schema-authorized ref positions, never narrative text or arbitrary input. */
function expandReferenceHandles(
  value: unknown,
  schema: JsonSchema,
  catalogue: ReturnType<typeof referenceCatalogue>,
): unknown {
  const refs = new Map(catalogue.map((item) => [item.handle, item.ref]));
  const localSchema = (pointer: string): unknown => {
    if (!pointer.startsWith('#/')) return undefined;
    let current: unknown = schema;
    for (const segment of pointer.slice(2).split('/')) {
      if (!record(current)) return undefined;
      current = current[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
    return current;
  };
  const visit = (input: unknown, contract: unknown, depth = 0): unknown => {
    if (!record(contract) || depth > 64) return input;
    if (exactReferenceShape(contract))
      return typeof input === 'string' && refs.has(input)
        ? structuredClone(refs.get(input)!)
        : input;
    let result = input;
    if (typeof contract.$ref === 'string')
      result = visit(result, localSchema(contract.$ref), depth + 1);
    for (const branch of ['allOf', 'anyOf', 'oneOf'])
      if (Array.isArray(contract[branch]))
        for (const alternative of contract[branch])
          result = visit(result, alternative, depth + 1);
    if (Array.isArray(result)) {
      const items = contract.items;
      const prefix = Array.isArray(contract.prefixItems)
        ? contract.prefixItems
        : [];
      return result.map((item, index) =>
        visit(item, prefix[index] ?? items, depth + 1),
      );
    }
    if (record(result) && record(contract.properties)) {
      const properties = contract.properties;
      return Object.fromEntries(
        Object.entries(result).map(([key, child]) => [
          key,
          visit(child, properties[key], depth + 1),
        ]),
      );
    }
    return result;
  };
  return visit(value, schema);
}

/** Render explicitly chosen source aliases; selection and evidence authority are unchanged. */
function expandSourceCitations(
  value: unknown,
  context: unknown,
  catalogue: ReturnType<typeof referenceCatalogue>,
): unknown {
  if (
    !record(value) ||
    !record(value.action) ||
    value.action.type !== 'finalize' ||
    typeof value.action.answer !== 'string' ||
    !Array.isArray(value.action.sources) ||
    !record(context)
  )
    return value;
  const same = (
    left: z.infer<typeof artifactRefSchema>,
    right: z.infer<typeof artifactRefSchema>,
  ) =>
    left.id === right.id &&
    left.version === right.version &&
    left.sha256 === right.sha256;
  const declared: unknown[] =
    record(context.request) && Array.isArray(context.request.context_refs)
      ? [...(context.request.context_refs as unknown[])]
      : [];
  if (Array.isArray(context.corrections))
    for (const correction of context.corrections)
      if (record(correction) && Array.isArray(correction.context_refs))
        declared.push(...(correction.context_refs as unknown[]));
  const compactImports = Array.isArray(
    context.current_import_context_ref_indices,
  )
    ? context.current_import_context_ref_indices.flatMap((index: unknown) => {
        const parsed =
          typeof index === 'number' && Number.isSafeInteger(index) && index >= 0
            ? artifactRefSchema.safeParse(declared[index])
            : undefined;
        return parsed?.success ? [parsed.data] : [];
      })
    : [];
  const markers = new Map<string, string>();
  let imports = 0,
    captures = 0;
  for (const selected of value.action.sources) {
    const source = artifactRefSchema.safeParse(selected);
    if (!source.success) continue;
    const entry = catalogue.find((item) => same(item.ref, source.data));
    const artifact: unknown = Array.isArray(context.artifacts)
      ? context.artifacts.find((item: unknown) => {
          if (!record(item)) return false;
          const parsed = artifactRefSchema.safeParse(item.ref);
          return parsed.success && same(parsed.data, source.data);
        })
      : undefined;
    const isImport =
      (record(artifact) && artifact.kind === 'source.import') ||
      compactImports.some((ref) => same(ref, source.data));
    const marker = isImport
      ? `S${++imports}`
      : artifact
        ? `E${++captures}`
        : undefined;
    if (entry && marker && !markers.has(entry.handle))
      markers.set(entry.handle, marker);
  }
  return {
    ...value,
    action: {
      ...value.action,
      answer: value.action.answer.replace(
        /\[(ref:[1-9]\d*)\]/gu,
        (token, handle: string) =>
          markers.has(handle) ? `[${markers.get(handle)!}]` : token,
      ),
    },
  };
}

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
  const referenceCatalog = referenceCatalogue(context);
  const constrained = explicitlyNoReferences(context);
  const version = MANAGER_REFERENCE_CONTRACT_VERSION;
  const peerPolicy = managerPeerPolicy(context);
  const templates = managerPlanTemplates(context);
  const retainable = managerRetainableAssignments(context);
  const peerConstrained = Boolean(
    peerPolicy?.missing.length || peerPolicy?.grants.length,
  );
  if (
    !constrained &&
    !peerConstrained &&
    !templates.length &&
    retainable === null &&
    !referenceCatalog.length
  )
    return {
      schema: baseSchema,
      outputSchema: baseJSON,
      constrained,
      version,
      referenceCatalog,
    };

  let outputSchema = constrained
    ? managerReferenceOutputSchema(baseJSON)
    : baseJSON;
  const canonicalAction = outputSchema.properties?.action;
  if (
    templates.length &&
    canonicalAction !== undefined &&
    canonicalAction !== false
  ) {
    outputSchema = {
      ...outputSchema,
      properties: {
        ...outputSchema.properties,
        action: {
          anyOf: [
            canonicalAction === true ? {} : canonicalAction,
            {
              type: 'object',
              properties: {
                type: { const: 'apply_plan' },
                template: {
                  type: 'string',
                  enum: templates.map((template) => template.handle),
                },
                reason: { type: 'string', minLength: 1, maxLength: 4096 },
              },
              required: ['type', 'template', 'reason'],
              additionalProperties: false,
            },
          ],
        },
      },
    };
  }
  if (retainable !== null) {
    outputSchema = {
      ...outputSchema,
      allOf: [
        ...(Array.isArray(outputSchema.allOf) ? outputSchema.allOf : []),
        {
          type: 'object',
          properties: {
            action: {
              type: 'object',
              properties: {
                retain_assignment_ids: retainable.length
                  ? {
                      type: 'array',
                      items: { type: 'string', enum: retainable },
                    }
                  : { type: 'array', items: {}, maxItems: 0 },
              },
            },
          },
        },
      ],
    };
  }
  if (peerConstrained && peerPolicy) {
    const coordinationSchema = (choice: {
      participants: { assignment_id: string; revision: number }[];
      purpose: string;
    }): JsonSchema => ({
      type: 'object',
      properties: {
        type: { const: 'coordinate' },
        purpose: { const: choice.purpose },
        participants: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          prefixItems: choice.participants.map((item) => ({
            type: 'object',
            properties: {
              assignment_id: { const: item.assignment_id },
              revision: { const: item.revision },
            },
            required: ['assignment_id', 'revision'],
            additionalProperties: false,
          })),
        },
      },
      required: ['type', 'participants', 'purpose'],
      additionalProperties: false,
    });
    const alternatives = peerPolicy.missing.flatMap((choice) => [
      coordinationSchema(choice),
      coordinationSchema({
        ...choice,
        participants: [...choice.participants].reverse(),
      }),
    ]);
    const duplicates = peerPolicy.grants.flatMap((grant) => [
      coordinationSchema(grant),
      coordinationSchema({
        ...grant,
        participants: [...grant.participants].reverse(),
      }),
    ]);
    const actionPolicy: JsonSchema = alternatives.length
      ? {
          anyOf: [
            {
              type: 'object',
              properties: {
                type: {
                  enum: managerActionSchema.options
                    .map((option) => option.shape.type.value)
                    .filter((type) => type !== 'coordinate'),
                },
              },
              required: ['type'],
            },
            ...alternatives,
          ],
        }
      : { not: { anyOf: duplicates } };
    outputSchema = {
      ...outputSchema,
      allOf: [
        ...(Array.isArray(outputSchema.allOf) ? outputSchema.allOf : []),
        { type: 'object', properties: { action: actionPolicy } },
      ],
    };
  }
  const schema = baseSchema.superRefine((value: unknown, check) => {
    if (!record(value)) return;
    const parsedAction = managerActionSchema.safeParse(value.action);
    if (
      parsedAction.success &&
      parsedAction.data.type === 'finalize' &&
      /\[ref:[^\]]+\]/u.test(parsedAction.data.answer)
    )
      check.addIssue({
        code: 'custom',
        path: ['action', 'answer'],
        message:
          'A citation handle must name an explicitly selected source with a known citation class.',
      });
    if (
      parsedAction.success &&
      parsedAction.data.type === 'apply_plan' &&
      retainable !== null &&
      parsedAction.data.retain_assignment_ids.some(
        (id) => !retainable.includes(id),
      )
    )
      check.addIssue({
        code: 'custom',
        path: ['action', 'retain_assignment_ids'],
        message: 'invalid_retain_assignment_ids',
      });
    if (parsedAction.success && parsedAction.data.type === 'coordinate') {
      const issue = managerCoordinationIssue(context, parsedAction.data);
      if (issue)
        check.addIssue({
          code: 'custom',
          path: ['action'],
          message: issue.code,
        });
    }
    if (!constrained) return;
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
  return {
    schema:
      templates.length || referenceCatalog.length
        ? z.preprocess(
            (value) =>
              expandManagerPlanTemplate(
                expandSourceCitations(
                  expandReferenceHandles(value, baseJSON, referenceCatalog),
                  context,
                  referenceCatalog,
                ),
                templates,
              ),
            schema,
          )
        : schema,
    outputSchema: referenceCatalog.length
      ? referenceHandleOutputSchema(outputSchema, referenceCatalog)
      : outputSchema,
    constrained,
    version,
    referenceCatalog,
  };
}
