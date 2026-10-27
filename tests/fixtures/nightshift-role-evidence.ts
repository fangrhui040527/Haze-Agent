import { createHash } from 'node:crypto';
import {
  frozenRoleEvaluationSuite,
  prepareReleaseRoleProbe,
  roleEvaluationEvidenceSchema,
  type FrozenRoleCase,
  type RoleEvaluationEvidence,
} from '../../app/release/nightshift-role-evidence.js';
import type { ReleaseBindings } from '../../app/release/nightshift-release.js';
import { canonicalJson } from '../../app/contracts/json.js';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function retainedRoleReportFixture(
  outputs: readonly unknown[],
  bindings: ReleaseBindings,
) {
  const report = JSON.stringify({
    mode: 'live-requested-synthetic-context',
    contract_passed: true,
    release_bindings: bindings,
    bindings_sha256: hash(canonicalJson(bindings)),
    suite_sha256: frozenRoleEvaluationSuite().sha256,
    attempts: outputs.map((output) => ({
      ...(output as RoleEvaluationEvidence['outputs'][number]),
      status: 'contract-passed',
      adapter_called: true,
    })),
  });
  return { bytes: report, sha256: hash(report) };
}
const set = (value: Record<string, unknown>, path: string, item: unknown) => {
  const keys = path.split('.');
  let target = value;
  for (const key of keys.slice(0, -1)) {
    target[key] ??= {};
    target = target[key] as Record<string, unknown>;
  }
  target[keys.at(-1)!] = item;
};
function outcome(entry: FrozenRoleCase) {
  const type =
    entry.role === 'Manager'
      ? (entry.criteria.equals?.['action.type'] ??
        entry.criteria.one_of?.['action.type']?.[0])
      : (entry.criteria.equals?.type ?? 'finish');
  let value: Record<string, unknown>;
  if (entry.role === 'Manager') {
    const action =
      type === 'finalize'
        ? {
            type,
            answer: 'The evidence gap remains explicit.',
            work_products: [],
            sources: [],
            uncertainty: [],
            unfinished: [],
          }
        : type === 'wait'
          ? { type, reason: 'Await the known unresolved outcome.' }
          : { type, prompt: 'Please supply the missing exact source.' };
    value = {
      id: entry.context.decision_id,
      run_id: entry.context.run_id,
      generation: entry.context.generation,
      objective_revision: entry.context.objective_revision,
      plan_revision: entry.context.plan_revision,
      event_cursor: entry.context.event_cursor,
      explanation: 'Frozen comparison fixture.',
      references: [],
      action,
    };
  } else if (type === 'tool')
    value = { id: entry.id, type, tool: '', input: {} };
  else if (type === 'save_tool_result')
    value = { id: entry.id, type, kind: '', tool_action_id: '' };
  else if (type === 'question')
    value = {
      id: entry.id,
      type,
      prompt: 'Please provide the missing boundary.',
    };
  else
    value = {
      id: entry.id,
      type,
      summary: 'The requested scientific support remains incomplete.',
      support: 'gap',
      outputs: [],
      uncertainty: ['Required independent evidence remains missing.'],
    };
  for (const [path, item] of Object.entries({
    ...entry.criteria.equals,
    ...entry.criteria.exact_references,
  }))
    set(value, path, item);
  for (const [path, choices] of Object.entries(entry.criteria.one_of ?? {}))
    set(value, path, choices[0]);
  return JSON.stringify(value);
}

/** Mock provider records for validator tests; never usable as live release evidence. */
export function roleEvaluationFixture(bindings: ReleaseBindings) {
  const frozen = frozenRoleEvaluationSuite();
  const outputs = frozen.suite.cases.flatMap((entry) => {
    const prepared = prepareReleaseRoleProbe(
      entry,
      frozen.suite.limits.max_output_tokens,
    );
    const output = outcome(entry);
    return (['inherited-baseline', 'configured-candidate'] as const).map(
      (selection) => {
        const route =
          selection === 'configured-candidate'
            ? bindings.routes[entry.role]!
            : {
                route_id: 'baseline-lightning',
                provider: 'nvidia',
                requested_model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
              };
        return {
          role: entry.role,
          scenario: entry.id,
          selection,
          route,
          agent_version: prepared.agent_version,
          input: prepared.input,
          input_sha256: hash(JSON.stringify(prepared.input)),
          output,
          output_sha256: hash(output),
          passed: true,
          response_model: route.requested_model,
          latency_ms: 1000,
          receipt: {
            response_model: route.requested_model,
            response_id: `${entry.id}-${selection}`,
            input_tokens: 100,
            output_tokens: 40,
            response_status: 'stop',
            http_status: 200,
          },
        };
      },
    );
  });
  const bindingsHash = hash(canonicalJson(bindings));
  return roleEvaluationEvidenceSchema.parse({
    evaluator: 'role-evaluation-runner',
    passed: true,
    scenarios: frozen.suite.cases.length,
    instructions_sha256: bindings.instructions_sha256,
    bindings_sha256: bindingsHash,
    retained_report: retainedRoleReportFixture(outputs, bindings),
    suite: { bytes: frozen.bytes.toString('utf8'), sha256: frozen.sha256 },
    outputs,
    model_calls_by_role: Object.fromEntries(
      [...new Set(outputs.map((output) => output.role))].map((role) => [
        role,
        outputs.filter((output) => output.role === role).length,
      ]),
    ),
  });
}
