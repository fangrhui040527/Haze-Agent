import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ModelRouteRegistry } from '../dist/adapters/model-routes.js';
import { AgentModelResponseError } from '../dist/adapters/agent-model.js';
import {
  NIGHTSHIFT_BASE_URL,
  nightshiftCredentialReference,
  resolveRouteCredential,
} from '../dist/adapters/nightshift/runtime.js';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    model: { type: 'string' },
    output: { type: 'string' },
  },
});
const configured = new ModelRouteRegistry(process.env);
const selected = Object.values(configured.snapshot().routes).find(
  (route) => route.provider === 'nightshift',
);
const requestedModel =
  values.model || selected?.requested_model || process.env.HAZE_MODEL;
if (!requestedModel)
  throw new Error('Configure the exact Nightshift model or provide --model.');
const baseUrl = selected?.base_url || NIGHTSHIFT_BASE_URL;
const token = resolveRouteCredential(
  selected?.credential_ref || nightshiftCredentialReference(process.env),
  process.env,
);
if (!token) throw new Error('Nightshift server credential is unavailable.');
const registry = new ModelRouteRegistry({
  ...process.env,
  HAZE_PROVIDER: 'nightshift',
  HAZE_MODEL: requestedModel,
  HAZE_PROVIDER_BASE_URL: baseUrl,
  HAZE_AGENT_ROUTES_JSON: JSON.stringify({ version: 1, routes: {} }),
  METERLESS_TOKEN: token,
});
const root = resolve(
  values.output || '.state/routing-validation/nightshift-strict',
  `${Date.now()}-${randomUUID()}`,
);
await mkdir(root, { recursive: true });
const report = {
  version: 1,
  mode: values.live ? 'bounded-live-transport-probes' : 'read-only-inspection',
  started_at: new Date().toISOString(),
  requested_model: requestedModel,
  checks: [],
  calls_attempted: 0,
  probes: [],
  role_quality: 'unverified',
  role_default_promotion: false,
};
const save = () =>
  writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await save();
try {
  const unauthorized = await fetch(
    `${baseUrl}/haze/contract?model=${encodeURIComponent(requestedModel)}`,
    {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    },
  );
  void unauthorized.body?.cancel().catch(() => undefined);
  report.checks.push({
    name: 'authentication-required',
    status: unauthorized.status,
    passed: unauthorized.status === 401,
  });
  const unknown = await fetch(
    `${baseUrl}/haze/contract?model=haze-unknown-model`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    },
  );
  void unknown.body?.cancel().catch(() => undefined);
  report.checks.push({
    name: 'unknown-model-rejected',
    status: unknown.status,
    passed: unknown.status === 409,
  });
  report.readiness = await registry.readiness();
  const route = registry.snapshot().routes.Manager;
  const model = await registry.prepare(route, AbortSignal.timeout(3000));
  report.checks.push({
    name: 'strict-contract-negotiated',
    passed: true,
    capability_contract: route.capability_contract,
  });
  if (values.live) {
    for (const probe of [
      {
        name: 'structured-json',
        input: {
          role: 'Manager',
          instruction:
            'Return exactly one JSON object with the single boolean field ok set to true.',
          context: {
            purpose:
              'Synthetic strict transport verification; no tool execution.',
          },
          max_output_tokens: 64,
          json_mode: true,
          output_schema: {
            type: 'object',
            properties: { ok: { type: 'boolean', const: true } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      },
      {
        name: 'forced-truncation',
        input: {
          role: 'Manager',
          instruction:
            'Return a JSON object with the field explanation containing at least two hundred words explaining air pollution. Write the full explanation.',
          context: {
            purpose: 'Synthetic token-cap verification; no tool execution.',
          },
          max_output_tokens: 8,
          json_mode: true,
        },
      },
    ]) {
      const attempt = {
        name: probe.name,
        input: probe.input,
        status: 'intent-recorded',
        receipt: null,
        output: null,
        passed: false,
      };
      report.probes.push(attempt);
      report.calls_attempted++;
      await save();
      const started = performance.now();
      try {
        const completion = await model.completeWithReceipt(
          probe.input,
          AbortSignal.timeout(120_000),
        );
        attempt.receipt = completion.receipt;
        attempt.output = completion.text;
        attempt.status = 'completed';
        if (probe.name === 'structured-json') {
          const output = JSON.parse(completion.text);
          attempt.passed =
            output?.ok === true && Object.keys(output).length === 1;
        }
      } catch (error) {
        if (error instanceof AgentModelResponseError) {
          attempt.receipt = error.receipt;
          attempt.output = error.output;
          attempt.status = 'response-rejected';
          attempt.passed =
            probe.name === 'forced-truncation' &&
            error.receipt.response_status === 'length' &&
            error.receipt.output_tokens !== null &&
            error.receipt.output_tokens <= probe.input.max_output_tokens;
        } else attempt.status = 'unknown-or-unavailable';
      }
      attempt.latency_ms = Math.round(performance.now() - started);
      await save();
    }
  }
  // Source hashes are evidence of the activated overlay, never credentials.
  if (process.env.LOCALAPPDATA) {
    try {
      report.installation = JSON.parse(
        await readFile(
          join(
            process.env.LOCALAPPDATA,
            'Nightshift',
            'engine',
            'haze-strict-installation.json',
          ),
          'utf8',
        ),
      );
    } catch {
      /* Remote/custom installations need no local file. */
    }
  }
  report.passed =
    report.checks.every((check) => check.passed) &&
    report.probes.every((probe) => probe.passed);
} catch {
  report.passed = false;
  report.failure =
    'Strict runtime negotiation or bounded verification failed; no default was promoted.';
} finally {
  report.completed_at = new Date().toISOString();
  await save();
}
console.log(
  JSON.stringify(
    {
      report: join(root, 'report.json'),
      passed: report.passed,
      calls_attempted: report.calls_attempted,
      checks: report.checks,
      probes: report.probes.map(
        ({ name, status, receipt, passed, latency_ms }) => ({
          name,
          status,
          receipt,
          passed,
          latency_ms,
        }),
      ),
    },
    null,
    2,
  ),
);
if (!report.passed) process.exitCode = 1;
