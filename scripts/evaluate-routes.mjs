import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  assessRouteOutput,
  prepareRouteEvaluation,
  safeEvaluationRoute,
} from './route-evaluation-support.mjs';
import { captureVerificationBindings } from './domain-verification-support.mjs';

const { values: options } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    inspect: { type: 'boolean', default: false },
    role: { type: 'string' },
    output: { type: 'string' },
  },
});
if (options.live && options.inspect)
  throw new Error('Select --live or --inspect.');
const bytes = await readFile(
  new URL('../docs/testing/cases/route-evaluation-cases.json', import.meta.url),
);
const suite = JSON.parse(bytes);
const cases = suite.cases.filter(
  (entry) => !options.role || entry.role === options.role,
);
if (cases.length === 0)
  throw new Error('No scenarios match the selected role.');
const root = resolve(
  options.output ?? '.state/route-evaluation',
  `${Date.now()}-${randomUUID()}`,
);
await mkdir(root, { recursive: true });
// Freeze the exact scenarios and gates before resolving a route or making a call.
await writeFile(join(root, 'scenarios.json'), bytes, { flag: 'wx' });
const { ModelRouteRegistry } = await import('../dist/adapters/model-routes.js');
const { parseContractJson } = await import('../dist/contracts/json.js');
const { AgentModelResponseError, AgentModelOutcomeUnknownError } =
  await import('../dist/adapters/agent-model.js');
const definitions = await Promise.all([
  import('../dist/agents/manager/index.js').then((m) => m.managerAgent),
  import('../dist/agents/hazeops/index.js').then((m) => m.hazeOpsAgent),
  import('../dist/agents/workershield/index.js').then(
    (m) => m.workerShieldAgent,
  ),
  import('../dist/agents/evidence-critic/index.js').then(
    (m) => m.evidenceCriticAgent,
  ),
  import('../dist/agents/damage-accountant/index.js').then(
    (m) => m.damageAccountantAgent,
  ),
]);
const agents = new Map(definitions.map((agent) => [agent.id, agent]));
const candidate = new ModelRouteRegistry(process.env);
const baseline = new ModelRouteRegistry({
  ...process.env,
  HAZE_AGENT_ROUTES_JSON: JSON.stringify({ version: 1, routes: {} }),
});
const selections = [
  {
    label: 'inherited-baseline',
    registry: baseline,
    snapshot: baseline.snapshot(),
  },
  {
    label: 'configured-candidate',
    registry: candidate,
    snapshot: candidate.snapshot(),
  },
];
const report = {
  version: 1,
  started_at: new Date().toISOString(),
  mode: options.live ? 'live-requested-synthetic-context' : 'inspection-only',
  suite_sha256: createHash('sha256').update(bytes).digest('hex'),
  limits: suite.limits,
  gates: suite.gates,
  routes: selections.map(({ label, snapshot }) => ({
    label,
    routes: Object.fromEntries(
      Object.entries(snapshot.routes).map(([role, route]) => [
        role,
        safeEvaluationRoute(route),
      ]),
    ),
  })),
  readiness: [],
  attempts: [],
  role_default_promotion:
    'forbidden: independent quality review and end-to-end role evidence required',
  limitations: [
    'These are controlled single-decision probes with synthetic evidence and tool descriptions. No tool action is executed.',
    'Contract success does not establish live evidence retrieval, complete task quality, scientific validity or role evaluation approval.',
    'Use the existing manager:evaluate harness for Manager supervision/recovery flows; retain end-to-end specialist task traces separately.',
  ],
  // Captured before any live call. Evidence assembly must preserve these exact
  // build/instruction/contract/route/runtime identities rather than relabel old outputs.
  ...(options.live ? await captureVerificationBindings(process.env) : {}),
};
const save = () =>
  writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
for (const { label, registry } of selections) {
  report.readiness.push({ label, result: await registry.readiness() });
  await save();
}
if (options.live) {
  for (const entry of cases) {
    for (const { label, registry, snapshot } of selections) {
      const route = snapshot.routes[entry.role];
      const agent = agents.get(entry.role);
      const { schema, input, action_contract_version } = prepareRouteEvaluation(
        agent,
        entry.context,
        suite.limits.max_output_tokens,
      );
      if (
        Buffer.byteLength(JSON.stringify(input), 'utf8') >
        suite.limits.max_input_bytes
      )
        throw new Error('Frozen scenario exceeds its admitted input limit.');
      const attempt = {
        id: randomUUID(),
        scenario: entry.id,
        role: entry.role,
        selection: label,
        route: safeEvaluationRoute(route),
        input_sha256: createHash('sha256')
          .update(JSON.stringify(input))
          .digest('hex'),
        agent_version: agent.version,
        action_contract_version,
        input,
        started_at: new Date().toISOString(),
        status: 'intent-recorded',
        adapter_called: false,
        receipt: null,
        output: null,
        assessment: null,
      };
      report.attempts.push(attempt);
      await appendFile(
        join(root, 'attempts.ndjson'),
        JSON.stringify(attempt) + '\n',
      );
      await save();
      const started = performance.now();
      let dispatched = false;
      try {
        const signal = AbortSignal.timeout(suite.limits.timeout_ms);
        const model = await registry.prepare(route, signal);
        dispatched = true;
        attempt.adapter_called = true;
        const result = await model.completeWithReceipt(input, signal);
        attempt.output = result.text;
        attempt.receipt = result.receipt;
        attempt.assessment = assessRouteOutput(
          result.text,
          schema,
          entry.criteria,
          parseContractJson,
        );
        attempt.status =
          attempt.assessment.failures.length === 0
            ? 'contract-passed'
            : 'action-rejected';
      } catch (error) {
        if (error instanceof AgentModelResponseError) {
          attempt.receipt = error.receipt;
          attempt.output = error.output;
          attempt.status = 'response-rejected';
        } else if (
          error instanceof AgentModelOutcomeUnknownError ||
          (dispatched && error?.name === 'AbortError')
        ) {
          attempt.status = 'unknown-outcome';
        } else {
          attempt.status = dispatched ? 'request-rejected' : 'route-blocked';
        }
        // Upstream errors can include secrets. Retain classifications and known-safe adapter receipts only.
        attempt.error = attempt.status;
      }
      attempt.latency_ms = Math.round(performance.now() - started);
      attempt.latency_gate = attempt.latency_ms <= suite.gates.max_latency_ms;
      attempt.receipt_complete = Boolean(
        typeof attempt.receipt?.response_model === 'string' &&
        attempt.receipt.response_model.trim() &&
        typeof attempt.receipt?.response_id === 'string' &&
        attempt.receipt.response_id.trim() &&
        [attempt.receipt.input_tokens, attempt.receipt.output_tokens].every(
          (tokens) => Number.isSafeInteger(tokens) && tokens >= 0,
        ) &&
        !attempt.receipt.synthetic,
      );
      attempt.output_cap_gate =
        attempt.receipt_complete &&
        attempt.receipt.output_tokens <= suite.limits.max_output_tokens;
      await appendFile(
        join(root, 'attempts.ndjson'),
        JSON.stringify(attempt) + '\n',
      );
      await save();
    }
  }
}
report.finished_at = new Date().toISOString();
report.contract_passed =
  options.live &&
  report.attempts.every(
    (entry) =>
      entry.status === 'contract-passed' &&
      entry.latency_gate &&
      entry.receipt_complete &&
      entry.output_cap_gate,
  );
report.quality_gate = 'pending-independent-review';
report.summary = {
  attempted_scenarios: report.attempts.length,
  adapter_calls: report.attempts.filter((entry) => entry.adapter_called).length,
  blocked_routes: report.attempts.filter(
    (entry) => entry.status === 'route-blocked',
  ).length,
  received_receipts: report.attempts.filter((entry) => entry.receipt !== null)
    .length,
};
report.comparison = cases.map(({ id, role }) => ({
  scenario: id,
  role,
  attempts: report.attempts
    .filter((entry) => entry.scenario === id)
    .map(({ selection, status, assessment, latency_ms, receipt }) => ({
      selection,
      status,
      assessment,
      latency_ms,
      receipt,
    })),
}));
await save();
console.log(
  JSON.stringify({
    report: join(root, 'report.json'),
    attempts: report.attempts.length,
    contract_passed: report.contract_passed,
    quality_gate: report.quality_gate,
  }),
);
if (options.live && !report.contract_passed) process.exitCode = 1;
