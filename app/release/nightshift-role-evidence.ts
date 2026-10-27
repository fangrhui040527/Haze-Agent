import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { agentRoleSchema, type AgentRole } from '../contracts/capabilities.js';
import { boundedJsonSchema } from '../contracts/artifacts.js';
import { canonicalJson, parseContractJson } from '../contracts/json.js';
import { managerAgent } from '../agents/manager/index.js';
import { hazeOpsAgent } from '../agents/hazeops/index.js';
import { workerShieldAgent } from '../agents/workershield/index.js';
import { evidenceCriticAgent } from '../agents/evidence-critic/index.js';
import { damageAccountantAgent } from '../agents/damage-accountant/index.js';
import {
  createManagerReferenceContract,
  MANAGER_REFERENCE_CONTRACT_VERSION,
} from '../agents/manager/reference-contract.js';
import {
  createSpecialistActionContract,
  SPECIALIST_ACTION_CONTRACT_VERSION,
} from '../orchestration/action-contract.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().trim().min(1).max(4096);
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const routeSchema = z.strictObject({
  route_id: text,
  provider: z.enum(['nvidia', 'nightshift', 'openai-compatible']),
  requested_model: text,
});
export const roleEvaluationEvidenceSchema = z.strictObject({
  evaluator: text,
  passed: z.literal(true),
  scenarios: z.number().int().positive(),
  instructions_sha256: sha256,
  bindings_sha256: sha256,
  suite: z.strictObject({ bytes: z.string().min(1).max(1_048_576), sha256 }),
  retained_report: z.strictObject({
    bytes: z.string().min(1).max(4_194_304),
    sha256,
  }),
  outputs: z
    .array(
      z.strictObject({
        role: agentRoleSchema,
        scenario: text,
        selection: z.enum(['inherited-baseline', 'configured-candidate']),
        route: routeSchema,
        agent_version: text,
        input: boundedJsonSchema,
        input_sha256: sha256,
        output: z.string().min(1).max(131_072),
        output_sha256: sha256,
        passed: z.boolean(),
        response_model: text,
        latency_ms: z.number().nonnegative(),
        receipt: z.strictObject({
          response_model: text,
          response_id: text,
          input_tokens: z.number().int().positive(),
          output_tokens: z.number().int().positive(),
          response_status: z.literal('stop'),
          http_status: z.number().int().min(200).max(299),
          synthetic: z.never().optional(),
        }),
      }),
    )
    .min(1)
    .max(512),
  model_calls_by_role: z.partialRecord(
    agentRoleSchema,
    z.number().int().nonnegative(),
  ),
});
export type RoleEvaluationEvidence = z.infer<
  typeof roleEvaluationEvidenceSchema
>;
const suiteSchema = z.strictObject({
  version: z.literal(1),
  scope: text,
  limits: z.strictObject({
    calls_per_scenario_per_route: z.literal(1),
    max_output_tokens: z.number().int().positive(),
    max_input_bytes: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
  }),
  gates: z.strictObject({
    strict_action_success_rate: z.literal(1),
    correct_outcome_rate: z.literal(1),
    reference_integrity_rate: z.literal(1),
    max_latency_ms: z.number().positive(),
    actual_provider_receipts_required: z.literal(true),
    independent_quality_review_required: z.literal(true),
    genuine_end_to_end_role_traces_required: z.literal(true),
    automatic_promotion: z.literal(false),
  }),
  cases: z
    .array(
      z.strictObject({
        id: text,
        role: agentRoleSchema,
        focus: text,
        context: z.record(z.string(), z.unknown()),
        criteria: z.strictObject({
          equals: z.record(z.string(), z.unknown()).optional(),
          one_of: z.record(z.string(), z.array(z.unknown())).optional(),
          exact_references: z.record(z.string(), z.unknown()).optional(),
          nonempty: z.array(text).optional(),
        }),
      }),
    )
    .min(1)
    .max(256),
});
export type FrozenRoleCase = z.infer<typeof suiteSchema>['cases'][number];
const agents = new Map(
  [
    managerAgent,
    hazeOpsAgent,
    workerShieldAgent,
    evidenceCriticAgent,
    damageAccountantAgent,
  ].map((agent) => [agent.id, agent]),
);

/** The exact suite installed with this application, not an evidence-supplied subset. */
export function frozenRoleEvaluationSuite() {
  const url = new URL(
    '../../docs/testing/cases/route-evaluation-cases.json',
    import.meta.url,
  );
  if (statSync(url).size > 1_048_576)
    throw new Error('Frozen role suite exceeds its bound.');
  const bytes = readFileSync(url);
  if (bytes.byteLength > 1_048_576)
    throw new Error('Frozen role suite exceeds its bound.');
  return {
    bytes,
    sha256: hash(bytes),
    suite: suiteSchema.parse(
      parseContractJson(bytes.toString('utf8'), 1_048_576),
    ),
  };
}

/** Reconstruct the real probe from current instructions and production permissions. */
export function prepareReleaseRoleProbe(
  entry: FrozenRoleCase,
  maxOutputTokens: number,
) {
  const agent = agents.get(entry.role);
  if (!agent) throw new Error('Unknown frozen role.');
  const baseSchema =
    entry.role === 'Manager'
      ? agent.schemas?.decision
      : agent.schemas?.specialist;
  if (!baseSchema)
    throw new Error('Frozen role has no registered decision schema.');
  const specialist =
    entry.role === 'Manager'
      ? undefined
      : createSpecialistActionContract(entry.context, baseSchema);
  const manager =
    entry.role === 'Manager'
      ? createManagerReferenceContract(entry.context, baseSchema)
      : undefined;
  const input = {
    role: agent.id,
    instruction: agent.instructions,
    context: specialist
      ? {
          ...entry.context,
          action_contract: {
            version: SPECIALIST_ACTION_CONTRACT_VERSION,
            allowed_actions: specialist.allowedActions,
          },
        }
      : entry.context,
    output_schema:
      specialist?.outputSchema ??
      manager?.outputSchema ??
      z.toJSONSchema(baseSchema),
    max_output_tokens: maxOutputTokens,
    json_mode: true,
  };
  return {
    agent_version: agent.version,
    action_contract_version: manager?.constrained
      ? MANAGER_REFERENCE_CONTRACT_VERSION
      : specialist
        ? SPECIALIST_ACTION_CONTRACT_VERSION
        : undefined,
    schema: specialist?.schema ?? manager?.schema ?? baseSchema,
    input,
  };
}
const at = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (item, key) =>
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)[key]
          : undefined,
      value,
    );

/** Re-evaluate retained bytes; passed booleans and hashes alone confer no release. */
export function validateRoleEvaluation(
  evaluation: RoleEvaluationEvidence,
  bindings: {
    instructions_sha256: string;
    routes: Partial<
      Record<
        AgentRole,
        { route_id: string; provider: string; requested_model: string | null }
      >
    >;
  },
  strictRoles: readonly AgentRole[],
  exactModel: string,
): void {
  const frozen = frozenRoleEvaluationSuite();
  if (evaluation.bindings_sha256 !== hash(canonicalJson(bindings)))
    throw new Error(
      'Role evaluation was not captured under the current full release bindings.',
    );
  if (
    hash(evaluation.retained_report.bytes) !== evaluation.retained_report.sha256
  )
    throw new Error(
      'Retained role evaluation report bytes do not match their hash.',
    );
  const retained = parseContractJson(
    evaluation.retained_report.bytes,
    4_194_304,
  ) as Record<string, unknown>;
  if (
    retained.mode !== 'live-requested-synthetic-context' ||
    retained.contract_passed !== true ||
    retained.bindings_sha256 !== evaluation.bindings_sha256 ||
    canonicalJson(retained.release_bindings) !== canonicalJson(bindings) ||
    retained.suite_sha256 !== frozen.sha256 ||
    !Array.isArray(retained.attempts)
  )
    throw new Error(
      'A complete retained live role report captured under the current full bindings is required.',
    );
  const rawAttempts = retained.attempts as Record<string, unknown>[];
  if (rawAttempts.length !== evaluation.outputs.length)
    throw new Error(
      'Role comparison outputs must preserve every actual retained attempt.',
    );
  const rawKeys = new Map(
    rawAttempts.map((attempt) => [
      `${String(attempt.scenario)}\0${String(attempt.role)}\0${String(attempt.selection)}`,
      attempt,
    ]),
  );
  if (rawKeys.size !== rawAttempts.length)
    throw new Error(
      'Retained role report repeats a baseline or candidate attempt.',
    );
  for (const output of evaluation.outputs) {
    const raw = rawKeys.get(
      `${output.scenario}\0${output.role}\0${output.selection}`,
    );
    const rawRoute = raw?.route as Record<string, unknown> | undefined;
    if (
      !raw ||
      raw.status !== 'contract-passed' ||
      raw.adapter_called !== true ||
      canonicalJson({
        role: raw.role,
        scenario: raw.scenario,
        selection: raw.selection,
        route: {
          route_id: rawRoute?.route_id,
          provider: rawRoute?.provider,
          requested_model: rawRoute?.requested_model,
        },
        agent_version: raw.agent_version,
        input: raw.input,
        input_sha256: raw.input_sha256,
        output: raw.output,
        receipt: raw.receipt,
        latency_ms: raw.latency_ms,
      }) !==
        canonicalJson({
          role: output.role,
          scenario: output.scenario,
          selection: output.selection,
          route: output.route,
          agent_version: output.agent_version,
          input: output.input,
          input_sha256: output.input_sha256,
          output: output.output,
          receipt: output.receipt,
          latency_ms: output.latency_ms,
        })
    )
      throw new Error(
        'Role comparison summary does not match its retained raw provider attempt.',
      );
  }
  if (
    evaluation.suite.sha256 !== hash(evaluation.suite.bytes) ||
    evaluation.suite.sha256 !== frozen.sha256 ||
    evaluation.suite.bytes !== frozen.bytes.toString('utf8')
  )
    throw new Error(
      'Role evaluation must retain the exact current frozen suite bytes and hash.',
    );
  if (evaluation.instructions_sha256 !== bindings.instructions_sha256)
    throw new Error(
      'Role evaluation instructions no longer match the current registered instructions.',
    );
  const { suite } = frozen;
  if (
    evaluation.scenarios !== suite.cases.length ||
    evaluation.outputs.length !== suite.cases.length * 2
  )
    throw new Error(
      'Role evaluation must cover every frozen scenario for both baseline and candidate routes.',
    );
  const expected = new Set(
    suite.cases.flatMap((entry) =>
      ['inherited-baseline', 'configured-candidate'].map(
        (selection) => `${entry.id}\0${entry.role}\0${selection}`,
      ),
    ),
  );
  for (const output of evaluation.outputs) {
    const key = `${output.scenario}\0${output.role}\0${output.selection}`;
    if (!expected.delete(key))
      throw new Error(
        'Role evaluation contains missing, repeated or unrecognized frozen cases.',
      );
    const entry = suite.cases.find(
      (candidate) =>
        candidate.id === output.scenario && candidate.role === output.role,
    )!;
    const prepared = prepareReleaseRoleProbe(
      entry,
      suite.limits.max_output_tokens,
    );
    if (
      output.agent_version !== prepared.agent_version ||
      canonicalJson(output.input) !== canonicalJson(prepared.input) ||
      output.input_sha256 !== hash(JSON.stringify(prepared.input)) ||
      output.input_sha256 !== hash(JSON.stringify(output.input))
    )
      throw new Error(
        'Role evaluation input does not match the current role instructions and exact frozen context.',
      );
    if (!output.passed || hash(output.output) !== output.output_sha256)
      throw new Error(
        'Role evaluation output must match its retained bytes and pass independently recomputed checks.',
      );
    if (
      Buffer.byteLength(JSON.stringify(output.input), 'utf8') >
        suite.limits.max_input_bytes ||
      output.latency_ms > suite.gates.max_latency_ms ||
      output.receipt.output_tokens > suite.limits.max_output_tokens
    )
      throw new Error(
        'Role evaluation exceeds its frozen input, output or latency gate.',
      );
    if (
      output.receipt.response_model !== output.response_model ||
      output.response_model !== output.route.requested_model
    )
      throw new Error(
        'Role evaluation requires a genuine receipt with the exact requested response model.',
      );
    if (output.selection === 'configured-candidate') {
      if (
        canonicalJson(output.route) !==
        canonicalJson(bindings.routes[output.role])
      )
        throw new Error(
          'Candidate role evaluation does not use the exact current pinned route.',
        );
      if (
        strictRoles.includes(output.role) &&
        output.response_model !== exactModel
      )
        throw new Error(
          'Every strict candidate role evaluation must return the exact Ultra model identity.',
        );
    }
    const parsed = prepared.schema.safeParse(parseContractJson(output.output));
    if (!parsed.success)
      throw new Error(
        'Retained role evaluation output fails the current production action contract.',
      );
    const { criteria } = entry;
    for (const [path, expectedValue] of Object.entries({
      ...criteria.equals,
      ...criteria.exact_references,
    }))
      if (!isDeepStrictEqual(at(parsed.data, path), expectedValue))
        throw new Error(
          'Retained role evaluation output fails its frozen outcome or exact-reference criteria.',
        );
    for (const [path, choices] of Object.entries(criteria.one_of ?? {}))
      if (
        !choices.some((choice) =>
          isDeepStrictEqual(at(parsed.data, path), choice),
        )
      )
        throw new Error(
          'Retained role evaluation output fails its frozen permitted-outcome criteria.',
        );
    for (const path of criteria.nonempty ?? []) {
      const value = at(parsed.data, path);
      if (!(typeof value === 'string' || Array.isArray(value)) || !value.length)
        throw new Error(
          'Retained role evaluation output omits a required nonempty outcome.',
        );
    }
  }
  if (expected.size)
    throw new Error(
      'Role evaluation omits frozen baseline or candidate cases.',
    );
  for (const role of new Set(evaluation.outputs.map((output) => output.role)))
    if (
      evaluation.model_calls_by_role[role] !==
      evaluation.outputs.filter((output) => output.role === role).length
    )
      throw new Error(
        'Actual model calls per role must equal the retained frozen comparison attempts.',
      );
}
