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
  const records = new Map();
  const bind = (ref) => {
    if (ref.id === bundleId) return;
    if (!ref.id.startsWith('demo:'))
      throw new Error('fixture_reference_must_be_demo_local');
    const record =
      ref.id === planning.baseline.ref.id
        ? {
            id: ref.id,
            revision: ref.revision,
            assignments: planning.baseline.assignments,
            notice: fixtureNotice,
          }
        : { id: ref.id, revision: ref.revision, notice: fixtureNotice };
    ref.sha256 = contractHash(record);
    records.set(`${ref.id}@${ref.revision}`, { ref: { ...ref }, record });
  };
  visitReferences(planning, bind);
  visitReferences(result, bind);
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
  validateContract('planning', planning);
  validateContract('run', request, 'historical_harness');
  validateContract('result', result);
  const digest = contractHash(planning);
  const known = new Map(
    records.map(({ ref, record }) => {
      if (
        ref.sha256 !== contractHash(record) ||
        ref.id !== record.id ||
        ref.revision !== record.revision ||
        record.notice !== fixtureNotice
      ) {
        throw new Error('fixture_record_hash_or_identity_mismatch');
      }
      return [`${ref.id}@${ref.revision}`, ref.sha256];
    }),
  );
  if (known.size !== records.length)
    throw new Error('duplicate_fixture_record');
  known.set(`${bundleId}@1`, digest);
  for (const fixture of [planning, request, result])
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
    result.result.recommendation_eligible !== false
  ) {
    throw new Error('fixture_surface_or_origin_mismatch');
  }
  console.log(
    'Validated v2 planning/run/result fixtures and canonical bundle hashes; no workflow executed.',
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
