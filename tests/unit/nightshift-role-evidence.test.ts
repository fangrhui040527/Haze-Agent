import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentRoleSchema } from '../../app/contracts/capabilities.js';
import { validateRoleEvaluation } from '../../app/release/nightshift-role-evidence.js';
import {
  NVIDIA_ULTRA_MODEL,
  STRICT_RELEASE_ROLES,
  type ReleaseBindings,
} from '../../app/release/nightshift-release.js';
import {
  roleEvaluationFixture,
  retainedRoleReportFixture,
} from '../fixtures/nightshift-role-evidence.js';

const bindings: ReleaseBindings = {
  build_sha256: 'a'.repeat(64),
  instructions_sha256: 'b'.repeat(64),
  contracts_sha256: 'c'.repeat(64),
  routes: Object.fromEntries(
    agentRoleSchema.options.map((role) => [
      role,
      {
        route_id: `current-${role}`,
        provider: 'nvidia',
        requested_model: NVIDIA_ULTRA_MODEL,
      },
    ]),
  ),
  nightshift: {
    runtime_version: '1.2.1',
    schema_hash: 'd'.repeat(64),
    installation_fingerprint: 'e'.repeat(64),
    cloud_lanes: [
      { lane: 'cloud-lane', provider: 'nvidia', model: NVIDIA_ULTRA_MODEL },
    ],
    roster_fingerprint: createHash('sha256')
      .update(JSON.stringify([['cloud-lane', 'nvidia', NVIDIA_ULTRA_MODEL]]))
      .digest('hex'),
  },
};
const validate = (value = roleEvaluationFixture(bindings)) => {
  value.retained_report = retainedRoleReportFixture(value.outputs, bindings);
  validateRoleEvaluation(
    value,
    bindings,
    STRICT_RELEASE_ROLES,
    NVIDIA_ULTRA_MODEL,
  );
};

describe('current frozen role evaluation proof', () => {
  it('recomputes every baseline and candidate action against current instructions and frozen criteria', () => {
    expect(() => validate()).not.toThrow();
  });
  it('rejects missing or repeated scenario/route pairs and changed frozen suite bytes', () => {
    const missing = roleEvaluationFixture(bindings);
    missing.outputs.pop();
    expect(() => validate(missing)).toThrow('every frozen scenario');
    const duplicate = roleEvaluationFixture(bindings);
    duplicate.outputs[1] = duplicate.outputs[0]!;
    expect(() => validate(duplicate)).toThrow(/repeat/u);
    const suite = roleEvaluationFixture(bindings);
    suite.suite.bytes += '\n';
    suite.suite.sha256 = createHash('sha256')
      .update(suite.suite.bytes)
      .digest('hex');
    expect(() => validate(suite)).toThrow('current frozen suite');
  });
  it('rejects altered instructions, route identity, retained input or output bytes', () => {
    const instructions = roleEvaluationFixture(bindings);
    instructions.instructions_sha256 = '0'.repeat(64);
    expect(() => validate(instructions)).toThrow(
      'instructions no longer match',
    );
    const route = roleEvaluationFixture(bindings);
    route.outputs.find(
      (entry) => entry.selection === 'configured-candidate',
    )!.route.route_id = 'stale-route';
    expect(() => validate(route)).toThrow('pinned route');
    const input = roleEvaluationFixture(bindings);
    (input.outputs[0]!.input as { instruction: string }).instruction =
      'Changed instruction';
    expect(() => validate(input)).toThrow('current role instructions');
    const output = roleEvaluationFixture(bindings);
    output.outputs[0]!.output = '{}';
    expect(() => validate(output)).toThrow('retained bytes');
  });
  it('rechecks production action permissions and exact outcome criteria instead of trusting passed', () => {
    const action = roleEvaluationFixture(bindings);
    action.outputs[0]!.output = JSON.stringify({ arbitrary: 'not an action' });
    action.outputs[0]!.output_sha256 = createHash('sha256')
      .update(action.outputs[0]!.output)
      .digest('hex');
    expect(() => validate(action)).toThrow('production action contract');
    const outcome = roleEvaluationFixture(bindings);
    const value = JSON.parse(outcome.outputs[0]!.output) as { action: object };
    value.action = { type: 'question', prompt: 'Unnecessary question' };
    outcome.outputs[0]!.output = JSON.stringify(value);
    outcome.outputs[0]!.output_sha256 = createHash('sha256')
      .update(outcome.outputs[0]!.output)
      .digest('hex');
    expect(() => validate(outcome)).toThrow('frozen outcome');
  });
  it('preserves latency, output ceilings, exact receipt identity and actual role counts', () => {
    const slow = roleEvaluationFixture(bindings);
    slow.outputs[0]!.latency_ms = 90_001;
    expect(() => validate(slow)).toThrow('latency gate');
    const long = roleEvaluationFixture(bindings);
    long.outputs[0]!.receipt.output_tokens = 2401;
    expect(() => validate(long)).toThrow('output or latency gate');
    const identity = roleEvaluationFixture(bindings);
    identity.outputs[0]!.receipt.response_model = 'different-model';
    expect(() => validate(identity)).toThrow('exact requested response model');
    const calls = roleEvaluationFixture(bindings);
    calls.model_calls_by_role.Manager = 0;
    expect(() => validate(calls)).toThrow('Actual model calls per role');
  });
  it('rejects a relabeled old capture and a summary changed after raw capture', () => {
    const changed = roleEvaluationFixture(bindings);
    changed.outputs[0]!.output = 'Changed after capture';
    expect(() =>
      validateRoleEvaluation(
        changed,
        bindings,
        STRICT_RELEASE_ROLES,
        NVIDIA_ULTRA_MODEL,
      ),
    ).toThrow('raw provider attempt');
    const old = roleEvaluationFixture(bindings);
    const record = JSON.parse(old.retained_report.bytes) as {
      bindings_sha256: string;
    };
    record.bindings_sha256 = '0'.repeat(64);
    old.retained_report.bytes = JSON.stringify(record);
    old.retained_report.sha256 = createHash('sha256')
      .update(old.retained_report.bytes)
      .digest('hex');
    expect(() =>
      validateRoleEvaluation(
        old,
        bindings,
        STRICT_RELEASE_ROLES,
        NVIDIA_ULTRA_MODEL,
      ),
    ).toThrow('current full bindings');
  });
});
