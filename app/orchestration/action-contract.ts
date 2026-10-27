import { z } from 'zod';
import { artifactRefSchema, type ArtifactRef } from '../contracts/artifacts.js';
import { agentActionSchema, type AgentAction } from './contracts.js';

export const SPECIALIST_ACTION_CONTRACT_VERSION = 'haze.specialist-actions.v1';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const referenceKey = (ref: ArtifactRef) =>
  `${ref.id}:${ref.version}:${ref.sha256}`;

/** References describe choices, never replace the host's current authorization. */
function references(value: unknown, found = new Map<string, ArtifactRef>()) {
  if (Array.isArray(value)) {
    for (const item of value) references(item, found);
  } else if (record(value)) {
    const parsed = artifactRefSchema.safeParse({
      id: value.id,
      version: value.version,
      sha256: value.sha256,
    });
    if (parsed.success) found.set(referenceKey(parsed.data), parsed.data);
    else for (const item of Object.values(value)) references(item, found);
  }
  return found;
}

/**
 * Derive choices solely from admitted context and completed operations. The same
 * contract is used for inference and validation; evaluation criteria never enter it.
 */
export function createSpecialistActionContract(
  context: unknown,
  baseSchema: z.ZodType = agentActionSchema,
): {
  schema: z.ZodType<AgentAction>;
  outputSchema: Record<string, unknown>;
  allowedActions: AgentAction['type'][];
} {
  const ctx = record(context) ? context : {};
  const tools = list(ctx.tools)
    .filter(record)
    .filter((tool) => typeof tool.id === 'string');
  const peers = list('message_peers' in ctx ? ctx.message_peers : ctx.peers)
    .filter(record)
    .map((peer) => peer.id)
    .filter((id): id is string => typeof id === 'string');
  const retained = list(ctx.tool_results)
    .filter(record)
    .filter(
      (result) =>
        result.status === 'completed' && typeof result.action_id === 'string',
    );
  const jobs = list(ctx.acknowledged_jobs)
    .filter(record)
    .filter(
      (job) =>
        job.remote_acknowledged === true &&
        z.uuid().safeParse(job.job_id).success,
    )
    .map((job) => job.job_id as string);
  const refs = references([
    ctx.input,
    ctx.inputs,
    ctx.artifacts,
    ctx.outputs,
    ctx.shared_refs,
  ]);
  // Runtime assignment completion owns its produced outputs. Controlled probes
  // without an execution ledger can describe retained deliverables in input.
  const finishRefs =
    'owned_outputs' in ctx ? references(ctx.owned_outputs) : refs;
  const knownKinds = list(ctx.artifact_kinds).filter(
    (kind): kind is string => typeof kind === 'string',
  );
  const variants: z.ZodType[] = [];
  const allowedActions: AgentAction['type'][] = [];
  const baseJSON = z.toJSONSchema(baseSchema, { unrepresentable: 'any' });
  const supportedTypes = new Set<string>();
  const collectTypes = (value: unknown) => {
    if (!record(value)) return;
    if (record(value.properties) && record(value.properties.type)) {
      const type = value.properties.type;
      if (typeof type.const === 'string') supportedTypes.add(type.const);
      for (const item of list(type.enum))
        if (typeof item === 'string') supportedTypes.add(item);
    }
    for (const field of ['oneOf', 'anyOf', 'allOf'])
      for (const item of list(value[field])) collectTypes(item);
  };
  collectTypes(baseJSON);
  const add = (
    type: AgentAction['type'],
    shape?: Record<string, z.ZodType>,
  ) => {
    if (supportedTypes.size && !supportedTypes.has(type)) return;
    const option = agentActionSchema.options.find(
      (item) => item.shape.type.value === type,
    )!;
    variants.push(shape ? (option as z.ZodObject).extend(shape) : option);
    if (!allowedActions.includes(type)) allowedActions.push(type);
  };
  for (const tool of tools) {
    let input: z.ZodType = z.unknown();
    // Evaluation test doubles may have descriptive shorthand rather than JSON
    // Schema. Actual registered tools expose their generated input schema.
    if (
      record(tool.input_schema) &&
      typeof tool.input_schema.type === 'string'
    ) {
      input = z.fromJSONSchema(tool.input_schema);
    }
    add('tool', { tool: z.literal(tool.id as string), input });
  }
  if (knownKinds.length) add('save', { kind: z.enum(knownKinds) });
  for (const result of retained) {
    if (typeof result.artifact_kind !== 'string' && !knownKinds.length)
      continue;
    add('save_tool_result', {
      tool_action_id: z.literal(result.action_id as string),
      ...(typeof result.artifact_kind === 'string'
        ? { kind: z.literal(result.artifact_kind) }
        : knownKinds.length
          ? { kind: z.enum(knownKinds) }
          : {}),
    });
  }
  add('question');
  if (peers.length) {
    add('message', { recipient: z.enum(peers) });
  }
  if (peers.length || ctx.peer_wait_available === true) add('wait');
  if (ctx.escalation_available === true) add('escalate');
  if (jobs.length) {
    add('external_wait', {
      dependencies: z
        .array(z.strictObject({ job_id: z.enum(jobs), required: z.boolean() }))
        .min(1)
        .max(4),
    });
  }
  const refSchemas = [...finishRefs.values()].map((ref) =>
    z.strictObject({
      id: z.literal(ref.id),
      version: z.literal(ref.version),
      sha256: z.literal(ref.sha256),
    }),
  );
  const outputRef =
    refSchemas.length === 1
      ? refSchemas[0]!
      : refSchemas.length > 1
        ? z.union(refSchemas)
        : artifactRefSchema;
  add('finish', {
    outputs: refSchemas.length
      ? z.array(outputRef).max(64)
      : z.array(artifactRefSchema).max(0),
  });
  if (!variants.length)
    throw new Error(
      'The admitted specialist schema has no legal action in the current context.',
    );
  const policy = variants.length === 1 ? variants[0]! : z.union(variants);
  const policyJSON = z.toJSONSchema(policy, { unrepresentable: 'any' });
  const outputSchema =
    baseSchema === agentActionSchema
      ? policyJSON
      : { allOf: [baseJSON, policyJSON] };
  const schema = baseSchema.superRefine((action: unknown, check) => {
    const value = action as AgentAction;
    if (!allowedActions.includes(value.type)) {
      check.addIssue({
        code: 'custom',
        path: ['type'],
        message: `Action ${value.type} is not granted. Choose one of: ${allowedActions.join(', ')}.`,
      });
      return;
    }
    if (!policy.safeParse(action).success) {
      check.addIssue({
        code: 'custom',
        message:
          'The action violates its granted tool input schema, recipient, retained result kind, job handle or exact output reference. Use only the supplied contract choices.',
      });
      return;
    }
    const checkReferences = (input: unknown) => {
      for (const [key] of references(input)) {
        if (!refs.has(key))
          check.addIssue({
            code: 'custom',
            message:
              'Unknown or stale artifact reference; use an exact admitted reference.',
          });
      }
    };
    if (value.type === 'finish') {
      checkReferences(value.outputs);
      if (
        value.support !== 'supported' &&
        !value.uncertainty.some((text) => text.trim())
      ) {
        check.addIssue({
          code: 'custom',
          path: ['uncertainty'],
          message: 'Partial or gap support requires an explicit limitation.',
        });
      }
    } else if (value.type === 'tool') checkReferences(value.input);
  }) as z.ZodType<AgentAction>;
  return { schema, outputSchema, allowedActions };
}
