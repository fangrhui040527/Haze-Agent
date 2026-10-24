import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { format, resolveConfig } from 'prettier';
import { contractHash } from '../dist/contracts/index.js';
import {
  linkEvidence,
  parseSourceRows,
  selectionHash,
} from '../dist/evidence/linkage.js';
import { importSamplePack } from '../dist/import/loader.js';
import { validateContract } from '../dist/contracts/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const VALID_PACK = 'input_examples/v2';
const NEGATIVE_ROOT = 'input_examples/v2/negative';
const SCENARIOS = [
  { key: 'nominal', id: 'nominal' },
  { key: 'plus-20', id: 'plus_20_sensitivity' },
];
const REQUIRED_SCENARIOS = ['nominal', 'plus_20_sensitivity'];
const SOURCE_HEADER = 'row_id,location_id,start_utc,end_utc,value,unit';
const GENERATOR = {
  method_id: 'fixture:negative-case-generator',
  method_version: '1.0.0',
};
const NOTICE =
  'Fictional negative fixture derived from the valid sample pack; not accepted evidence and not an operating case.';

const readText = (path) => readFile(resolve(root, path), 'utf8');
const readBytes = (path) => readFile(resolve(root, path));
const readJson = async (path) => JSON.parse(await readText(path));
const sha256 = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
    .digest('hex');

async function writeOut(path, text) {
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text);
}

/** Write generated JSON already formatted, so `format:check` stays green. */
async function writeJsonOut(path, value) {
  const absolute = resolve(root, path);
  const options = await resolveConfig(absolute);
  await writeOut(
    path,
    await format(JSON.stringify(value), { ...options, parser: 'json' }),
  );
}

/* ------------------------------------------------------------------ cases */

/**
 * Each case is one documented transformation of the valid pack. `rows` may
 * return null to drop a source row entirely; `planning` edits operating facts.
 * Expected outcomes are declared here by hand, independently of the modules
 * under test.
 */
const CASES = [
  {
    case_id: 'missing-baseline-coverage',
    intent:
      'A required baseline hour is absent at an occupied location, so no quantified comparison exists for either scenario. The gap is reported precisely and is never filled with zero.',
    steps: [
      'Drop the yard source row covering 00:00-01:00Z (08:00-09:00 local) from both scenario CSVs, matched by location and interval so the nominal and derived +20 packs lose the same hour.',
      'Mark the matching resolved series interval as an explicit null with a reason.',
      'Re-bind raw, selection and evidence hashes and bump each changed evidence revision.',
    ],
    rows: (row) =>
      row.location_id === 'yard' && row.start === '2026-10-25T00:00:00Z'
        ? null
        : row,
    expected: {
      import_status: 'imported',
      validation_outcome: 'admitted_with_environmental_insufficiency',
      environmental_status: 'insufficient',
      quantified_comparison_available: false,
      transport_status_hint: 200,
      admitted: true,
      required_finding_codes: ['environmental_baseline_coverage_missing'],
      forbidden_finding_codes: [],
      selected_plan: null,
      affected: [
        {
          scenario_ids: REQUIRED_SCENARIOS,
          schedule_kind: 'baseline',
          activity_id: 'inspection',
          location_id: 'yard',
          worker_ids: ['worker-a', 'worker-b'],
          missing_intervals: [
            { start: '2026-10-25T00:00:00Z', end: '2026-10-25T01:00:00Z' },
          ],
        },
      ],
      notes:
        'Missing baseline support gives a null quantified comparison and the precise gaps. It is not zero exposure and not an improvement.',
    },
  },
  {
    case_id: 'missing-candidate-coverage',
    intent:
      'An hour the baseline does not occupy is absent, so the baseline stays covered and only the alternatives that need that hour are excluded.',
    steps: [
      'Drop the yard source row covering 03:00-04:00Z (11:00-12:00 local) from both scenario CSVs, matched by location and interval so the nominal and derived +20 packs lose the same hour.',
      'Mark the matching resolved series interval as an explicit null with a reason.',
      'Re-bind raw, selection and evidence hashes and bump each changed evidence revision.',
    ],
    rows: (row) =>
      row.location_id === 'yard' && row.start === '2026-10-25T03:00:00Z'
        ? null
        : row,
    expected: {
      import_status: 'imported',
      validation_outcome: 'admitted_with_supported_coverage',
      environmental_status: 'supported',
      quantified_comparison_available: true,
      transport_status_hint: 200,
      admitted: true,
      required_finding_codes: ['environmental_coverage_gap'],
      forbidden_finding_codes: ['environmental_baseline_coverage_missing'],
      selected_plan: null,
      excluded_schedule_ids: [
        'demo:verification-less-disruption',
        'demo:verification-lower-proxy',
      ],
      affected: [
        {
          scenario_ids: REQUIRED_SCENARIOS,
          schedule_kind: 'candidate',
          activity_id: 'maintenance',
          location_id: 'yard',
          worker_ids: ['worker-a', 'worker-b'],
          missing_intervals: [
            { start: '2026-10-25T03:00:00Z', end: '2026-10-25T04:00:00Z' },
          ],
        },
      ],
      notes:
        'A supported-subset result proves nothing about the excluded alternatives; the exclusions are reported rather than hidden.',
    },
  },
  {
    case_id: 'flat-pollution',
    intent:
      'Each fixed location is flat across the whole window with complete coverage, so moving fixed-duration activities cannot reduce the integral. Location levels still differ.',
    steps: [
      'Set every yard hour to 50 ug/m3 and every office hour to 20 ug/m3 in the nominal CSV.',
      'Apply the pinned +20 transformation, giving 70 and 40 ug/m3 respectively.',
      'Re-bind raw, selection and evidence hashes and bump each changed evidence revision.',
    ],
    rows: (row, scenarioKey) => ({
      ...row,
      value:
        (row.location_id === 'yard' ? 50 : 20) +
        (scenarioKey === 'plus-20' ? 20 : 0),
    }),
    expected: {
      import_status: 'imported',
      validation_outcome: 'admitted_with_supported_coverage',
      environmental_status: 'supported',
      quantified_comparison_available: true,
      transport_status_hint: 200,
      admitted: true,
      required_finding_codes: [],
      forbidden_finding_codes: [
        'environmental_coverage_gap',
        'environmental_baseline_coverage_missing',
      ],
      selected_plan: null,
      checked_search_scope: {
        schedules_checked: [
          'demo:fictional-ordinary-baseline',
          'demo:verification-less-disruption',
          'demo:verification-lower-proxy',
        ],
        exhaustive: false,
        note: 'Only these three illustrative schedules were checked. No claim is made about undiscovered schedules.',
      },
      arithmetic: {
        unit: 'ug/m3 * hours',
        crew_unit: 'person-hours * ug/m3',
        derivation:
          'Each location is constant, so a fixed-duration activity contributes level * duration wherever it starts. Yard holds two one-hour activities and office one two-hour activity.',
        nominal: {
          per_worker_total: 140,
          crew_total: 280,
          per_schedule_identical: true,
          absolute_gain: 0,
        },
        plus_20_sensitivity: {
          per_worker_total: 220,
          crew_total: 440,
          per_schedule_identical: true,
          absolute_gain: 0,
        },
      },
      notes:
        'Zero gain is a correct result, not a failure. A flat source cannot be turned into a timing benefit by reordering labels.',
    },
  },
  {
    case_id: 'invalid-baseline-precedence',
    intent:
      'The baseline places maintenance before its inspection predecessor. Operating input is invalid, so diagnostics are returned and no plan is produced.',
    steps: [
      'Move the baseline inspection start to 09:00 and the maintenance start to 08:00.',
      'Leave every other operating field, and the whole environmental pack, byte-identical.',
    ],
    usesValidEnvironmental: true,
    planning: (planning) => {
      for (const assignment of planning.baseline.assignments) {
        if (assignment.activity_id === 'inspection') {
          assignment.start = '2026-10-25T09:00:00+08:00';
        }
        if (assignment.activity_id === 'maintenance') {
          assignment.start = '2026-10-25T08:00:00+08:00';
        }
      }
    },
    expected: {
      import_status: 'draft_rejected',
      validation_outcome: 'operating_input_invalid',
      environmental_status: 'not_assessed',
      quantified_comparison_available: false,
      transport_status_hint: 422,
      admitted: false,
      required_finding_codes: ['precedence_violation'],
      forbidden_finding_codes: ['environmental_baseline_coverage_missing'],
      selected_plan: null,
      affected: [
        {
          scenario_ids: [],
          schedule_kind: 'baseline',
          activity_id: 'maintenance',
          location_id: 'yard',
          worker_ids: ['worker-a', 'worker-b'],
          missing_intervals: [],
        },
      ],
      notes:
        'Invalid operating input yields field-specific diagnostics. It never yields a selected plan, and the environmental pack is not assessed because the bundle is not admitted.',
    },
  },
];

/* ------------------------------------------------------- fixture derivation */

function renderSource(rows) {
  const lines = rows.map((row) =>
    [
      row.row_id,
      row.location_id,
      row.start,
      row.end,
      String(row.value),
      row.unit,
    ].join(','),
  );
  return `${[SOURCE_HEADER, ...lines].join('\n')}\n`;
}

/** Rebind one scenario's evidence and series to freshly derived source rows. */
function rebindScenario({
  scenarioKey,
  evidenceEnvelope,
  seriesEnvelope,
  rows,
  sourceText,
  nominalRefs,
  caseId,
}) {
  const rawSha256 = sha256(sourceText);
  const lines = renderSource(rows).trim().split('\n').slice(1);
  const byLocation = new Map();
  rows.forEach((row, index) => {
    const entry = byLocation.get(row.location_id) ?? { rows: [], lines: [] };
    entry.rows.push(row);
    entry.lines.push(lines[index]);
    byLocation.set(row.location_id, entry);
  });

  const refs = new Map();
  for (const record of evidenceEnvelope.records) {
    const locationId = record.locator.location_ids[0];
    const selected = byLocation.get(locationId) ?? { rows: [], lines: [] };
    record.revision += 1;
    record.raw_sha256 = rawSha256;
    record.locator.row_ids = selected.rows.map((row) => row.row_id);
    record.locator.intervals = selected.rows.map((row) => ({
      start: row.start,
      end: row.end,
      location_id: row.location_id,
    }));
    record.locator.selection_sha256 = selectionHash(selected.lines);
    record.limitations = [
      ...record.limitations,
      `Derived negative fixture case ${caseId}; see case.json for the transformation.`,
    ];
    if (scenarioKey === 'plus-20') {
      for (const step of record.provenance.chain) {
        step.input_refs = step.input_refs.map((input) => {
          const rebound = nominalRefs.get(input.id);
          return rebound ? { ...rebound } : input;
        });
      }
    }
    refs.set(record.evidence_id, {
      id: record.evidence_id,
      revision: record.revision,
      sha256: contractHash(record),
    });
  }

  for (const series of seriesEnvelope.series) {
    const record = evidenceEnvelope.records.find(
      (entry) => entry.evidence_id === series.evidence_ref.id,
    );
    const ref = refs.get(series.evidence_ref.id);
    series.evidence_ref = { ...ref };
    series.source_ref = {
      id: record.raw_ref,
      revision: series.source_ref.revision,
      sha256: rawSha256,
    };
    const selected = byLocation.get(series.location_id) ?? { rows: [] };
    const valueByStart = new Map(
      selected.rows.map((row) => [row.start, row.value]),
    );
    series.intervals = series.intervals.map((interval) => {
      const value = valueByStart.get(interval.start);
      return value === undefined
        ? {
            ...interval,
            value: null,
            null_reason: {
              code: 'fixture_source_row_withheld',
              explanation: `Source row removed by negative fixture case ${caseId}; the value stays missing and is never interpolated or zero-filled.`,
            },
          }
        : { ...interval, value, null_reason: null };
    });
  }
  return { rawSha256, refs };
}

async function generateCase(definition) {
  const caseDirectory = `${NEGATIVE_ROOT}/${definition.case_id}`;
  const planning = await readJson(`${VALID_PACK}/planning.json`);
  const paths = { planning: `${caseDirectory}/planning.json` };
  const environmental = {};
  const derivedRefs = [];

  if (definition.usesValidEnvironmental) {
    paths.environmental_source = `${VALID_PACK}/environmental`;
  } else {
    const nominalRefs = new Map();
    for (const { key } of SCENARIOS) {
      const originalSource = await readText(
        `${VALID_PACK}/environmental/${key}-pm25.csv`,
      );
      const evidenceEnvelope = await readJson(
        `${VALID_PACK}/environmental/${key}-evidence.json`,
      );
      const seriesEnvelope = await readJson(
        `${VALID_PACK}/environmental/${key}-series.json`,
      );
      const rows = parseSourceRows(originalSource)
        .rows.map((row) => definition.rows(row, key))
        .filter((row) => row !== null);
      const sourceText = renderSource(rows);
      const { refs } = rebindScenario({
        scenarioKey: key,
        evidenceEnvelope,
        seriesEnvelope,
        rows,
        sourceText,
        nominalRefs,
        caseId: definition.case_id,
      });
      if (key === 'nominal')
        for (const [id, ref] of refs) nominalRefs.set(id, ref);
      for (const ref of refs.values()) derivedRefs.push(ref);
      const prefix = `${caseDirectory}/environmental/${key}`;
      await writeOut(`${prefix}-pm25.csv`, sourceText);
      await writeJsonOut(`${prefix}-evidence.json`, evidenceEnvelope);
      await writeJsonOut(`${prefix}-series.json`, seriesEnvelope);
      environmental[key] = {
        raw: `${prefix}-pm25.csv`,
        evidence: `${prefix}-evidence.json`,
        series: `${prefix}-series.json`,
      };
    }
    planning.evidence_refs = derivedRefs;
  }

  definition.planning?.(planning);
  await writeJsonOut(paths.planning, planning);
  if (Object.keys(environmental).length > 0)
    paths.environmental = environmental;

  const descriptor = {
    fixture_kind: 'negative_fixture_case',
    case_id: definition.case_id,
    scope: 'fictional_fixture_only',
    input_origin: 'synthetic_fixture',
    operational_eligibility: false,
    recommendation_eligible: false,
    notice: NOTICE,
    intent: definition.intent,
    derivation: {
      source_pack: VALID_PACK,
      ...GENERATOR,
      regenerate: 'npm run inputs:negative',
      steps: definition.steps,
    },
    paths,
    required_scenarios: REQUIRED_SCENARIOS,
    expected: definition.expected,
  };
  await writeJsonOut(`${caseDirectory}/case.json`, descriptor);
  return descriptor;
}

async function generateNegativeFixtures() {
  const descriptors = [];
  for (const definition of CASES)
    descriptors.push(await generateCase(definition));
  await writeJsonOut(`${NEGATIVE_ROOT}/scenario-matrix.json`, {
    fixture_kind: 'negative_fixture_scenario_matrix',
    scope: 'fictional_fixture_only',
    input_origin: 'synthetic_fixture',
    operational_eligibility: false,
    notice: NOTICE,
    valid_pack: VALID_PACK,
    regenerate: 'npm run inputs:negative',
    cases: descriptors.map((descriptor) => ({
      case_id: descriptor.case_id,
      case_path: `${NEGATIVE_ROOT}/${descriptor.case_id}/case.json`,
      intent: descriptor.intent,
      expected_outcome: descriptor.expected.validation_outcome,
      expected_import_status: descriptor.expected.import_status,
      expected_environmental_status: descriptor.expected.environmental_status,
      quantified_comparison_available:
        descriptor.expected.quantified_comparison_available,
      required_finding_codes: descriptor.expected.required_finding_codes,
    })),
  });
  console.log(
    `Regenerated ${descriptors.length} fictional negative fixture cases and the scenario matrix; nothing was accepted, scored or published.`,
  );
}

/* ------------------------------------------------------------- import paths */

/** Resolve the source documents for the valid pack or one negative case. */
async function resolveSources(caseId) {
  if (!caseId || caseId === 'valid') {
    return {
      case_id: 'valid',
      planning: `${VALID_PACK}/planning.json`,
      verificationSchedules: `${VALID_PACK}/verification-schedules.json`,
      environmental: SCENARIOS.map(({ key, id }) => ({
        scenario_id: id,
        raw: `${VALID_PACK}/environmental/${key}-pm25.csv`,
        evidence: `${VALID_PACK}/environmental/${key}-evidence.json`,
        series: `${VALID_PACK}/environmental/${key}-series.json`,
      })),
      expected: null,
    };
  }
  const descriptor = await readJson(`${NEGATIVE_ROOT}/${caseId}/case.json`);
  const base = descriptor.paths.environmental_source ?? null;
  return {
    case_id: descriptor.case_id,
    planning: descriptor.paths.planning,
    verificationSchedules: `${VALID_PACK}/verification-schedules.json`,
    environmental: SCENARIOS.map(({ key, id }) => ({
      scenario_id: id,
      raw: base
        ? `${base}/${key}-pm25.csv`
        : descriptor.paths.environmental[key].raw,
      evidence: base
        ? `${base}/${key}-evidence.json`
        : descriptor.paths.environmental[key].evidence,
      series: base
        ? `${base}/${key}-series.json`
        : descriptor.paths.environmental[key].series,
    })),
    expected: descriptor.expected,
  };
}

async function loadImportRequest(sources) {
  const document = async (path) => ({ path, bytes: await readBytes(path) });
  return {
    planning: await document(sources.planning),
    verificationSchedules: await document(sources.verificationSchedules),
    environmental: await Promise.all(
      sources.environmental.map(async (entry) => ({
        scenario_id: entry.scenario_id,
        raw: await document(entry.raw),
        evidence: await document(entry.evidence),
        series: await document(entry.series),
      })),
    ),
    requiredScenarios: REQUIRED_SCENARIOS,
  };
}

/**
 * Import a valid fixture the pack has never seen, to show the result is
 * computed from bytes rather than matched to a stored answer.
 */
async function probeUnseenFixture(shippedBundleSha256) {
  const sources = await resolveSources('valid');
  const request = await loadImportRequest(sources);
  const planning = JSON.parse(request.planning.bytes.toString('utf8'));
  planning.programme_id = 'haze-unseen-fixture-probe';
  request.planning = {
    path: 'in-memory:unseen-valid-fixture.json',
    bytes: Buffer.from(`${JSON.stringify(planning, null, 2)}\n`, 'utf8'),
  };
  const result = importSamplePack(request);
  const sha256OfProbe = result.handoff?.bundle_ref.sha256 ?? null;
  return {
    probe: 'unseen_valid_fixture',
    intent:
      'A previously unseen valid bundle must import and hash to a new value, proving the pack is computed from bytes and not matched to a stored answer.',
    import_status: result.status,
    validation_outcome: result.validation.outcome,
    bundle_sha256: sha256OfProbe,
    differs_from_shipped_bundle: sha256OfProbe !== shippedBundleSha256,
    computed_not_matched:
      result.status === 'imported' &&
      result.validation.outcome === 'admitted_with_supported_coverage' &&
      sha256OfProbe !== null &&
      sha256OfProbe !== shippedBundleSha256,
  };
}

async function runImport(caseId) {
  const sources = await resolveSources(caseId);
  const result = importSamplePack(await loadImportRequest(sources));
  return { sources, result };
}

/* ------------------------------------------------------------------ ledger */

function compare(expected, result) {
  const mismatches = [];
  const check = (name, actual, wanted) => {
    if (wanted === undefined) return;
    if (actual !== wanted) {
      mismatches.push(
        `${name}: expected ${String(wanted)}, got ${String(actual)}`,
      );
    }
  };
  check('import_status', result.status, expected.import_status);
  check(
    'validation_outcome',
    result.validation.outcome,
    expected.validation_outcome,
  );
  check(
    'environmental_status',
    result.validation.environmental.status,
    expected.environmental_status,
  );
  check(
    'quantified_comparison_available',
    result.validation.quantified_comparison_available,
    expected.quantified_comparison_available,
  );
  check(
    'transport_status_hint',
    result.validation.transport_status_hint,
    expected.transport_status_hint,
  );
  check('admitted', result.validation.admitted, expected.admitted);
  const codes = new Set(result.findings.map((entry) => entry.code));
  for (const code of expected.required_finding_codes ?? []) {
    if (!codes.has(code)) mismatches.push(`missing required finding ${code}`);
  }
  for (const code of expected.forbidden_finding_codes ?? []) {
    if (codes.has(code)) mismatches.push(`unexpected finding ${code}`);
  }
  for (const scheduleId of expected.excluded_schedule_ids ?? []) {
    const excluded = result.validation.environmental.scenarios.every(
      (scenario) => scenario.excluded_schedule_ids.includes(scheduleId),
    );
    if (!excluded) mismatches.push(`schedule ${scheduleId} was not excluded`);
  }
  return mismatches;
}

async function runLedger() {
  const matrix = await readJson(`${NEGATIVE_ROOT}/scenario-matrix.json`);
  const entries = [];
  for (const caseId of [
    'valid',
    ...matrix.cases.map((entry) => entry.case_id),
  ]) {
    const { sources, result } = await runImport(caseId);
    const mismatches = sources.expected
      ? compare(sources.expected, result)
      : compare(
          {
            import_status: 'imported',
            validation_outcome: 'admitted_with_supported_coverage',
            environmental_status: 'supported',
            quantified_comparison_available: true,
            transport_status_hint: 200,
            admitted: true,
            required_finding_codes: [],
            forbidden_finding_codes: [
              'environmental_coverage_gap',
              'environmental_baseline_coverage_missing',
            ],
          },
          result,
        );
    entries.push({
      case_id: caseId,
      import_status: result.status,
      validation_outcome: result.validation.outcome,
      environmental_status: result.validation.environmental.status,
      quantified_comparison_available:
        result.validation.quantified_comparison_available,
      transport_status_hint: result.validation.transport_status_hint,
      recommendation_eligible: result.validation.recommendation_eligible,
      finding_codes: [
        ...new Set(result.findings.map((entry) => entry.code)),
      ].sort(),
      agrees_with_expectation: mismatches.length === 0,
      mismatches,
    });
  }
  const shipped = entries.find((entry) => entry.case_id === 'valid');
  const { result: shippedResult } = await runImport('valid');
  const unseen = await probeUnseenFixture(
    shippedResult.handoff?.bundle_ref.sha256 ?? null,
  );
  if (!unseen.computed_not_matched) {
    shipped?.mismatches.push(
      'unseen valid fixture was not computed from bytes',
    );
  }
  const ledger = {
    ledger_kind: 'fixture_case_outcome_ledger',
    scope: 'fictional_fixture_only',
    surface: 'historical_harness',
    publication_status: 'publication_disabled',
    recommendation_eligible: false,
    stages: {
      canonical_json_parse: 'run',
      contract_validation: 'run',
      input_and_evidence_validation: 'run',
      deterministic_import: 'run',
      evidence_linkage_trace: 'run',
      planner: 'not_run_no_implementation',
      independent_numerical_verification: 'not_run_no_implementation',
      application_user_interface: 'not_run_no_implementation',
      evidence_acceptance_review: 'not_run_no_authority',
      canonical_publication: 'not_run_publication_disabled',
    },
    cases: entries,
    answer_caching_probe: unseen,
  };
  await writeJsonOut('output_examples/v2/fixture-ledger.json', ledger);
  for (const entry of entries) {
    entry.agrees_with_expectation = entry.mismatches.length === 0;
  }
  const failed = entries.filter((entry) => !entry.agrees_with_expectation);
  for (const entry of entries) {
    console.log(
      `${entry.agrees_with_expectation ? 'agrees ' : 'DIFFERS'} ${entry.case_id}: ${entry.import_status} / ${entry.validation_outcome} / env=${entry.environmental_status}`,
    );
    for (const mismatch of entry.mismatches) console.log(`    ${mismatch}`);
  }
  console.log(
    `Ledger written for ${entries.length} cases; planner, verification and UI stages are recorded as not run.`,
  );
  if (failed.length > 0) throw new Error('fixture_case_outcome_mismatch');
}

/* ---------------------------------------------------------------- manifest */

async function buildManifest() {
  const files = [
    `${VALID_PACK}/planning.json`,
    `${VALID_PACK}/run.json`,
    `${VALID_PACK}/demo-records.json`,
    `${VALID_PACK}/verification-schedules.json`,
    ...SCENARIOS.flatMap(({ key }) => [
      `${VALID_PACK}/environmental/${key}-pm25.csv`,
      `${VALID_PACK}/environmental/${key}-evidence.json`,
      `${VALID_PACK}/environmental/${key}-series.json`,
    ]),
    'output_examples/v2/result.json',
    `${NEGATIVE_ROOT}/scenario-matrix.json`,
  ];
  const matrix = await readJson(`${NEGATIVE_ROOT}/scenario-matrix.json`);
  for (const entry of matrix.cases) {
    const descriptor = await readJson(entry.case_path);
    files.push(entry.case_path, descriptor.paths.planning);
    for (const scenario of Object.values(
      descriptor.paths.environmental ?? {},
    )) {
      files.push(scenario.raw, scenario.evidence, scenario.series);
    }
  }
  const entries = [];
  for (const path of files) {
    const bytes = await readBytes(path);
    entries.push({
      path,
      byte_length: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  const { result } = await runImport('valid');
  const manifest = {
    manifest_kind: 'fictional_sample_data_pack_manifest',
    scope: 'fictional_fixture_only',
    input_origin: 'synthetic_fixture',
    surface: 'historical_harness',
    publication_status: 'publication_disabled',
    operational_eligibility: false,
    recommendation_eligible: false,
    notice:
      'Every worker, location, service, timing right, concentration, threshold and scenario in this pack is a fictional engineering choice. The pack supplies no Malaysian observation and no operating approval.',
    versions: {
      serializer: result.serializer,
      contracts: {
        planning: 'haze.planning.v2',
        run: 'haze.run.v2',
        result: 'haze.result.v2',
        evidence: 'haze.evidence.v2',
        environmental_series: 'haze.environmental_series.v2',
      },
      source_selection_rule: 'single_declared_series_per_location_v1',
      sensitivity_method: {
        method_id: 'fixture:pm25-add-20-ug-m3',
        method_version: '1.0.0',
        note: 'Fictional engineering perturbation; not a forecast-error distribution or supported scientific uncertainty.',
      },
      negative_case_generator: GENERATOR,
    },
    environment: {
      timezone: 'Asia/Kuala_Lumpur',
      window: '2026-10-25T08:00:00+08:00/2026-10-25T12:00:00+08:00',
      planning_step_minutes: 15,
      canonical_unit: 'ug/m3',
      native_temporal_resolution: { value: 1, unit: 'hour' },
      allocation_convention: 'piecewise_constant_half_open',
    },
    bundle_ref: result.handoff?.bundle_ref ?? null,
    evidence_refs: result.handoff?.evidence_refs ?? [],
    unavailable_capabilities: result.unavailable_capabilities,
    canonical: result.canonical,
    regenerate: {
      fixture_bindings: 'npm run contracts:fixtures',
      negative_cases: 'npm run inputs:negative',
      manifest: 'npm run inputs:manifest',
      ledger: 'npm run inputs:ledger',
    },
    files: entries,
  };
  await writeJsonOut(`${VALID_PACK}/MANIFEST.json`, manifest);
  console.log(
    `Wrote a manifest for ${entries.length} fictional pack files; no record was accepted or published.`,
  );
}

/* --------------------------------------------------------------- reporting */

async function runLinks(caseId, scenarioId) {
  const sources = await resolveSources(caseId);
  const planning = validateContract(
    'planning',
    await readJson(sources.planning),
    'historical_harness',
  );
  const schedulesFixture = await readJson(sources.verificationSchedules);
  const schedules = [
    {
      schedule_id: planning.baseline.ref.id,
      kind: 'baseline',
      assignments: planning.baseline.assignments,
    },
    ...schedulesFixture.schedules.map((entry) => ({
      schedule_id: entry.record.id,
      kind: 'candidate',
      assignments: entry.record.assignments,
    })),
  ];
  const output = [];
  for (const entry of sources.environmental) {
    if (scenarioId && entry.scenario_id !== scenarioId) continue;
    const evidenceEnvelope = await readJson(entry.evidence);
    const seriesEnvelope = await readJson(entry.series);
    const rawText = await readText(entry.raw);
    const rawByRef = {};
    for (const record of evidenceEnvelope.records) {
      rawByRef[record.raw_ref] = rawText;
    }
    output.push(
      linkEvidence({
        planning,
        scenario: {
          scenario_id: entry.scenario_id,
          document: entry.series,
          evidence: evidenceEnvelope.records,
          series: seriesEnvelope.series,
          rawByRef,
        },
        schedules,
      }),
    );
  }
  console.log(
    JSON.stringify({ case_id: sources.case_id, scenarios: output }, null, 2),
  );
}

/* -------------------------------------------------------------------- main */

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      case: { type: 'string' },
      scenario: { type: 'string' },
    },
  });
  const [command] = positionals;
  if (command === 'negative') {
    await generateNegativeFixtures();
  } else if (command === 'validate') {
    const { sources, result } = await runImport(values.case);
    console.log(
      JSON.stringify(
        { case_id: sources.case_id, ...result.validation },
        null,
        2,
      ),
    );
    if (!result.validation.admitted) process.exitCode = 1;
  } else if (command === 'import') {
    const { sources, result } = await runImport(values.case);
    console.log(
      JSON.stringify(
        {
          case_id: sources.case_id,
          status: result.status,
          surface: result.surface,
          serializer: result.serializer,
          handoff: result.handoff,
          canonical: result.canonical,
          unavailable_capabilities: result.unavailable_capabilities,
          artifacts: result.artifacts,
          findings: result.findings,
        },
        null,
        2,
      ),
    );
    if (result.status !== 'imported') process.exitCode = 1;
  } else if (command === 'links') {
    await runLinks(values.case, values.scenario);
  } else if (command === 'ledger') {
    await runLedger();
  } else if (command === 'manifest') {
    await buildManifest();
  } else {
    throw new Error(
      'Expected negative, validate, import, links, ledger or manifest',
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({ ok: false, code: error?.message ?? String(error) }),
  );
  process.exitCode = 1;
}
