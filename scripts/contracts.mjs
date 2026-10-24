import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ContractError,
  CONTRACT_VERSIONS,
  exportContractSchemas,
  validateContract,
  parseContractJson,
  contractHash,
} from '../dist/contracts/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = async (path) =>
  parseContractJson(await readFile(resolve(root, path), 'utf8'));
const writeJson = async (path, value) =>
  writeFile(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);

const fixtureNotice =
  'Fictional contract specimen only; not accepted authority or evidence.';
const bundleId = 'demo:klang-fixture-input-v2';
const environmentalScenarios = ['nominal', 'plus-20'];

async function readEnvironmentalFixtures() {
  return Promise.all(
    environmentalScenarios.map(async (scenario) => ({
      scenario,
      evidence: await readJson(
        `input_examples/v2/environmental/${scenario}-evidence.json`,
      ),
      series: await readJson(
        `input_examples/v2/environmental/${scenario}-series.json`,
      ),
      raw: await readFile(
        resolve(root, `input_examples/v2/environmental/${scenario}-pm25.csv`),
      ),
    })),
  );
}

function visitReferences(value, visit) {
  if (value === null || typeof value !== 'object') return;
  if (
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    typeof value.id === 'string' &&
    Number.isInteger(value.revision) &&
    typeof value.sha256 === 'string'
  ) {
    visit(value);
  } else
    for (const entry of Object.values(value)) visitReferences(entry, visit);
}

async function bindFixtures() {
  const planning = await readJson('input_examples/v2/planning.json');
  const result = await readJson('output_examples/v2/result.json');
  const environmentalPacks = await readEnvironmentalFixtures();
  const evidenceRecords = environmentalPacks.flatMap(
    ({ evidence }) => evidence.records,
  );
  const evidenceById = new Map(
    evidenceRecords.map((record) => [record.evidence_id, record]),
  );
  planning.evidence_refs = evidenceRecords.map((record) => ({
    id: record.evidence_id,
    revision: record.revision,
    sha256: contractHash(record),
  }));
  const verificationSchedules = await readJson(
    'input_examples/v2/verification-schedules.json',
  );
  const records = new Map();
  const bind = (ref) => {
    if (ref.id === bundleId) return;
    if (!ref.id.startsWith('demo:'))
      throw new Error('fixture_reference_must_be_demo_local');
    const record =
      evidenceById.get(ref.id) ??
      (ref.id === planning.baseline.ref.id
        ? {
            id: ref.id,
            revision: ref.revision,
            assignments: planning.baseline.assignments,
            notice: fixtureNotice,
          }
        : ref.id === 'demo:fictional-no-travel-setup'
          ? {
              id: ref.id,
              revision: ref.revision,
              scope: 'fictional_fixture_only',
              no_travel_required: true,
              no_setup_required: true,
              operational_attestation: false,
              notice: fixtureNotice,
            }
          : ref.id === 'demo:fictional-no-bottlenecks'
            ? {
                id: ref.id,
                revision: ref.revision,
                scope: 'fictional_fixture_only',
                no_relevant_resource_bottlenecks_assumed: true,
                operational_attestation: false,
                notice: fixtureNotice,
              }
            : ref.id === 'demo:fictional-policy'
              ? {
                  id: ref.id,
                  revision: ref.revision,
                  policy_version: 'haze.decision_policy.v2',
                  scope: 'fictional_two_worker_engineering_example',
                  approval_status: 'not_approved',
                  operational_use_allowed: false,
                  allow_overtime: false,
                  allow_reassignment: false,
                  allow_new_controls: false,
                  worker_and_activity_nonincrease: true,
                  minimum_benefit: {
                    metric: 'crew_concentration_time_proxy_reduction_fraction',
                    threshold: 0.1,
                    comparison: 'greater_than_or_equal',
                    required_scenarios: ['nominal', 'plus_20_sensitivity'],
                    aggregation: 'each_required_scenario',
                  },
                  disruption_limits: {
                    maximum_total_absolute_timing_movement_minutes: 360,
                    maximum_changed_activities: 3,
                    maximum_per_activity_absolute_timing_movement_minutes: 120,
                    shared_activity_counting: 'once_per_activity_id',
                  },
                  uncertainty_note:
                    'The +20 sensitivity is a fictional engineering perturbation, not supported operational uncertainty.',
                  notice: fixtureNotice,
                }
              : { id: ref.id, revision: ref.revision, notice: fixtureNotice });
    ref.sha256 = contractHash(record);
    records.set(`${ref.id}@${ref.revision}`, { ref: { ...ref }, record });
  };
  visitReferences(planning, bind);
  visitReferences(result, bind);
  for (const { ref, record } of verificationSchedules.schedules) {
    if (
      !ref.id.startsWith('demo:') ||
      ref.id !== record.id ||
      ref.revision !== record.revision
    ) {
      throw new Error('verification_schedule_identity_mismatch');
    }
    ref.sha256 = contractHash(record);
    records.set(`${ref.id}@${ref.revision}`, { ref: { ...ref }, record });
  }
  const bundleRef = {
    id: bundleId,
    revision: 1,
    sha256: contractHash(planning),
  };
  result.decision_ref.bundle_ref = bundleRef;
  const request = {
    schema_version: 'haze.run.v2',
    programme_id: planning.programme_id,
    input: {
      operation: 'plan_outdoor_work',
      problem_id: planning.problem_id,
      bundle_ref: bundleRef,
      query:
        'What evidence is missing before these fixed-work schedules can be compared?',
    },
  };
  await writeJson('input_examples/v2/planning.json', planning);
  await writeJson('input_examples/v2/run.json', request);
  await writeJson(
    'input_examples/v2/verification-schedules.json',
    verificationSchedules,
  );
  await writeJson('output_examples/v2/result.json', result);
  await writeJson(
    'input_examples/v2/demo-records.json',
    [...records.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([, value]) => value),
  );
  console.log(
    'Bound synthetic fixture references to local record bytes; no evidence accepted or result computed.',
  );
}

async function checkFixtures() {
  const planning = await readJson('input_examples/v2/planning.json');
  const request = await readJson('input_examples/v2/run.json');
  const result = await readJson('output_examples/v2/result.json');
  const records = await readJson('input_examples/v2/demo-records.json');
  const environmentalPacks = await readEnvironmentalFixtures();
  const verificationSchedules = await readJson(
    'input_examples/v2/verification-schedules.json',
  );
  validateContract('planning', planning);
  validateContract('run', request, 'historical_harness');
  validateContract('result', result);
  if (
    verificationSchedules.fixture_kind !== 'verification_schedule_examples' ||
    verificationSchedules.scope !== 'illustrative_only' ||
    verificationSchedules.exhaustive !== false ||
    !Array.isArray(verificationSchedules.schedules) ||
    verificationSchedules.schedules.length !== 2
  ) {
    throw new Error('verification_schedule_scope_mismatch');
  }
  for (const { ref, record } of verificationSchedules.schedules) {
    if (
      ref.id !== record.id ||
      ref.revision !== record.revision ||
      ref.sha256 !== contractHash(record) ||
      record.example_kind !== 'illustrative_verification_only' ||
      !Array.isArray(record.assignments) ||
      record.assignments.length !== planning.activities.length
    ) {
      throw new Error('verification_schedule_record_mismatch');
    }
    const activityIds = record.assignments.map(
      (assignment) => assignment.activity_id,
    );
    if (new Set(activityIds).size !== activityIds.length) {
      throw new Error('verification_schedule_duplicate_activity');
    }
  }
  const policyRecord = records.find(
    ({ ref }) => ref.id === planning.policy_ref.id,
  )?.record;
  if (
    !policyRecord ||
    policyRecord.approval_status !== 'not_approved' ||
    policyRecord.operational_use_allowed !== false ||
    policyRecord.minimum_benefit?.threshold !== 0.1 ||
    JSON.stringify(policyRecord.minimum_benefit?.required_scenarios) !==
      JSON.stringify(['nominal', 'plus_20_sensitivity']) ||
    policyRecord.disruption_limits
      ?.maximum_total_absolute_timing_movement_minutes !== 360 ||
    policyRecord.disruption_limits?.maximum_changed_activities !== 3 ||
    policyRecord.disruption_limits
      ?.maximum_per_activity_absolute_timing_movement_minutes !== 120 ||
    planning.evidence_refs.length !==
      environmentalPacks.reduce(
        (count, { evidence }) => count + evidence.records.length,
        0,
      )
  ) {
    throw new Error('fictional_policy_or_evidence_boundary_mismatch');
  }
  const expectedEvidence = new Map();
  for (const { scenario, evidence, series, raw } of environmentalPacks) {
    const rawSha256 = createHash('sha256').update(raw).digest('hex');
    if (
      evidence.fixture_kind !== 'synthetic_environmental_evidence_records' ||
      evidence.scope !== 'fictional_fixture_only' ||
      evidence.scenario_id !==
        (scenario === 'nominal' ? 'nominal' : 'plus_20_sensitivity') ||
      series.fixture_kind !== 'synthetic_environmental_series' ||
      series.scope !== 'fictional_fixture_only' ||
      series.scenario_id !==
        (scenario === 'nominal' ? 'nominal' : 'plus_20_sensitivity') ||
      series.timezone !== planning.timezone ||
      evidence.records.length !== series.series.length
    ) {
      throw new Error(`environmental_fixture_envelope_mismatch:${scenario}`);
    }
    for (const record of evidence.records) {
      validateContract('evidence', record);
      if (
        record.raw_sha256 !== rawSha256 ||
        record.raw_ref !==
          `demo:raw-pm25-${scenario === 'nominal' ? 'nominal' : 'plus-20'}-csv` ||
        record.input_origin !== 'synthetic_fixture' ||
        record.source_kind !== 'synthetic_fixture'
      ) {
        throw new Error(
          `environmental_evidence_source_mismatch:${record.evidence_id}`,
        );
      }
      const reference = {
        id: record.evidence_id,
        revision: record.revision,
        sha256: contractHash(record),
      };
      expectedEvidence.set(`${reference.id}@${reference.revision}`, reference);
    }
    for (const environmentalSeries of series.series) {
      validateContract('environmental_series', environmentalSeries);
      const evidenceRecord = evidence.records.find(
        (record) => record.evidence_id === environmentalSeries.evidence_ref.id,
      );
      if (
        !evidenceRecord ||
        environmentalSeries.source_ref.id !== evidenceRecord.raw_ref ||
        environmentalSeries.source_ref.sha256 !== rawSha256 ||
        environmentalSeries.evidence_ref.sha256 !== contractHash(evidenceRecord)
      ) {
        throw new Error(
          `environmental_series_binding_mismatch:${environmentalSeries.series_id}`,
        );
      }
    }
  }
  const actualEvidence = new Map(
    planning.evidence_refs.map((reference) => [
      `${reference.id}@${reference.revision}`,
      reference,
    ]),
  );
  if (
    actualEvidence.size !== planning.evidence_refs.length ||
    actualEvidence.size !== expectedEvidence.size ||
    [...expectedEvidence].some(
      ([key, reference]) =>
        JSON.stringify(actualEvidence.get(key)) !== JSON.stringify(reference),
    )
  ) {
    throw new Error('planning_environmental_evidence_refs_mismatch');
  }
  const digest = contractHash(planning);
  const known = new Map(
    records.map(({ ref, record }) => {
      const recordId =
        record.schema_version === 'haze.evidence.v2'
          ? record.evidence_id
          : record.id;
      if (
        ref.sha256 !== contractHash(record) ||
        ref.id !== recordId ||
        ref.revision !== record.revision ||
        (record.schema_version !== 'haze.evidence.v2' &&
          record.notice !== fixtureNotice)
      ) {
        throw new Error('fixture_record_hash_or_identity_mismatch');
      }
      if (record.schema_version === 'haze.evidence.v2')
        validateContract('evidence', record);
      return [`${ref.id}@${ref.revision}`, ref.sha256];
    }),
  );
  if (known.size !== records.length)
    throw new Error('duplicate_fixture_record');
  known.set(`${bundleId}@1`, digest);
  for (const fixture of [
    planning,
    request,
    result,
    verificationSchedules,
    records,
  ])
    visitReferences(fixture, (ref) => {
      if (known.get(`${ref.id}@${ref.revision}`) !== ref.sha256)
        throw new Error('unresolved_fixture_reference');
    });
  for (const [name, reference] of [
    ['request', request.input.bundle_ref],
    ['result', result.decision_ref.bundle_ref],
  ]) {
    if (
      reference.id !== bundleId ||
      reference.revision !== 1 ||
      reference.sha256 !== digest
    ) {
      throw new Error(`${name}_bundle_reference_mismatch`);
    }
  }
  if (
    request.programme_id !== planning.programme_id ||
    result.programme_id !== planning.programme_id ||
    request.input.problem_id !== planning.problem_id ||
    result.problem_id !== planning.problem_id
  ) {
    throw new Error('fixture_identity_mismatch');
  }
  if (
    planning.input_origin !== 'synthetic_fixture' ||
    result.input_origin !== planning.input_origin ||
    result.execution_surface !== 'historical_harness' ||
    result.result.recommendation_eligible !== false ||
    result.result.publication_status !== 'publication_disabled' ||
    result.decision_ref.publication_ref !== null
  ) {
    throw new Error('fixture_surface_or_origin_mismatch');
  }
  console.log(
    'Validated v2 planning/run/result fixtures, illustrative schedules, and canonical bundle hashes; no workflow executed.',
  );
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { surface: { type: 'string', default: 'canonical' } },
  });
  const [command, kind, path] = positionals;
  if (command === 'generate' || command === 'check') {
    if (positionals.length !== 1) throw new Error('unexpected_arguments');
    if (command === 'generate')
      await mkdir(resolve(root, 'schemas'), { recursive: true });
    for (const [version, schema] of Object.entries(exportContractSchemas())) {
      const schemaPath = `schemas/${version}.schema.json`;
      if (command === 'generate') {
        await writeJson(schemaPath, schema);
      } else if (
        JSON.stringify(await readJson(schemaPath)) !== JSON.stringify(schema)
      ) {
        throw new Error(
          `schema_drift:${version}:run_npm_run_contracts_generate`,
        );
      }
    }
    if (command === 'check') await checkFixtures();
    else
      console.log(
        `Generated ${Object.keys(CONTRACT_VERSIONS).length} Draft 2020-12 structural schemas from the runtime contracts.`,
      );
  } else if (command === 'fixtures') {
    if (positionals.length !== 1) throw new Error('unexpected_arguments');
    await bindFixtures();
    await checkFixtures();
  } else if (command === 'validate') {
    if (positionals.length !== 3 || !Object.hasOwn(CONTRACT_VERSIONS, kind)) {
      throw new Error(
        `Usage: npm run contracts:validate -- ${Object.keys(CONTRACT_VERSIONS).join('|')} FILE [--surface canonical|historical_harness]`,
      );
    }
    if (!['canonical', 'historical_harness'].includes(values.surface))
      throw new Error('invalid_surface');
    validateContract(kind, await readJson(path), values.surface);
    console.log(
      JSON.stringify({
        valid: true,
        schema_version: CONTRACT_VERSIONS[kind],
        scope: 'contract_validation_only',
      }),
    );
  } else throw new Error('Expected generate, check, fixtures or validate');
} catch (error) {
  console.error(
    JSON.stringify(
      error instanceof ContractError
        ? { valid: false, code: error.code, details: error.details }
        : { valid: false, code: error.message },
    ),
  );
  process.exitCode = 1;
}
