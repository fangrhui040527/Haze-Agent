import type { ExecutionSurface, PlanningBundle } from '../contracts/index.js';
import { parseContractJson, validateContract } from '../contracts/index.js';
import { contractFindings } from './contract-findings.js';
import type {
  EnvironmentalAssessment,
  EnvironmentalPack,
  ResolvedPack,
  ScenarioCoverage,
  ScheduleInput,
} from './environmental.js';
import {
  CANONICAL_UNIT,
  assessScenarioCoverage,
  validateEnvironmentalPack,
} from './environmental.js';
import type { Finding } from './findings.js';
import { FINDING_CODES, finding } from './findings.js';

export type {
  Finding,
  FindingCode,
  FindingDomain,
  FindingSeverity,
} from './findings.js';
export { FINDING_CODES, pointer } from './findings.js';
export type {
  CoverageGap,
  CoverageGapReason,
  EnvironmentalAssessment,
  EnvironmentalPack,
  ScenarioCoverage,
  ScheduleInput,
} from './environmental.js';
export { CANONICAL_POLLUTANT, CANONICAL_UNIT } from './environmental.js';

/**
 * How the input failed, if it failed.
 *
 * Architecture v0.13 §15.2 distinguishes malformed or unsupported input,
 * invalid operating semantics and a completed environmental insufficiency. The
 * last is a domain answer with precise gaps, not a server fault.
 */
export type InputOutcome =
  | 'admitted_with_supported_coverage'
  | 'admitted_with_environmental_insufficiency'
  | 'operating_input_invalid'
  | 'malformed_or_unsupported_input';

export interface ValidationReport {
  outcome: InputOutcome;
  /** A valid admitted bundle requires complete, consistent operating facts. */
  admitted: boolean;
  operating_input_valid: boolean;
  /** True only when every assessed scenario has full baseline coverage. */
  quantified_comparison_available: boolean;
  environmental: EnvironmentalAssessment;
  findings: Finding[];
  /**
   * Suggested transport mapping for the app boundary: 400 for malformed or
   * unsupported contracts, 422 for invalid operating semantics, 200 for a
   * completed domain answer including an environmental insufficiency.
   */
  transport_status_hint: 400 | 422 | 200;
  /** Qualified intended-use review is never inferred from a schema pass. */
  applicability_status: 'not_assessed';
  acceptance_status: 'not_accepted';
  /** This validator never grants operational eligibility. */
  recommendation_eligible: false;
  input_origin: string | null;
  fictional_use: boolean;
}

export interface ValidateInputsRequest {
  planning: unknown;
  planningDocument?: string;
  environmental?: readonly EnvironmentalPack[];
  /** Alternatives to screen for coverage; the baseline is read from the bundle. */
  candidates?: readonly ScheduleInput[];
  /** Scenario IDs the declared policy requires, when one is supplied. */
  requiredScenarios?: readonly string[];
  surface?: ExecutionSurface;
}

/** Read a document's bytes without silent duplicate-key or overflow handling. */
export function parseInputDocument(
  source: string,
  document: string,
): { value: unknown; findings: Finding[] } {
  try {
    return { value: parseContractJson(source), findings: [] };
  } catch (error) {
    return {
      value: undefined,
      findings: contractFindings({ error, document }),
    };
  }
}

function originOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const origin = (value as Record<string, unknown>).input_origin;
  return typeof origin === 'string' ? origin : null;
}

/**
 * Validate operating inputs and their environmental support together.
 *
 * Missing operating facts prevent a valid admitted bundle. Missing
 * environmental support does not: it returns a structured insufficiency with
 * the precise gaps, or excludes only the affected alternatives when the
 * baseline remains covered. No gap is ever filled by zero, interpolation or an
 * invented indoor ratio, and no correction is applied automatically.
 */
export function validateInputs(
  request: ValidateInputsRequest,
): ValidationReport {
  const planningDocument =
    request.planningDocument ?? 'input_examples/v2/planning.json';
  const packs = request.environmental ?? [];
  const findings: Finding[] = [];
  const inputOrigin = originOf(request.planning);

  let planning: PlanningBundle | null = null;
  try {
    planning = validateContract(
      'planning',
      request.planning,
      request.surface ?? 'historical_harness',
    ) as PlanningBundle;
  } catch (error) {
    findings.push(
      ...contractFindings({
        error,
        document: planningDocument,
        value: request.planning,
        domain: 'operating_input',
      }),
    );
  }

  const resolvedPacks: ResolvedPack[] = [];
  for (const pack of packs) {
    const outcome = validateEnvironmentalPack(pack);
    findings.push(...outcome.findings);
    if (outcome.resolved) resolvedPacks.push(outcome.resolved);
  }

  const suppliedScenarios = new Set(
    resolvedPacks.map((pack) => pack.scenario_id),
  );
  const requiredScenarios = request.requiredScenarios ?? null;
  const missingScenarios = (requiredScenarios ?? []).filter(
    (scenario) => !suppliedScenarios.has(scenario),
  );
  for (const scenario of missingScenarios) {
    findings.push(
      finding({
        code: FINDING_CODES.environmental_scenario_missing,
        domain: 'environmental',
        severity: 'blocking',
        document: planningDocument,
        affected_ids: [scenario],
        message: `The declared policy requires scenario ${scenario}, which no supplied pack provides. Eligibility needs complete coverage in every required scenario; supply the pack rather than dropping the requirement.`,
      }),
    );
  }

  const scenarios: ScenarioCoverage[] = [];
  if (planning !== null) {
    const baseline: ScheduleInput = {
      schedule_id: planning.baseline.ref.id,
      kind: 'baseline',
      assignments: planning.baseline.assignments,
    };
    const schedules = [baseline, ...(request.candidates ?? [])];
    for (const pack of resolvedPacks) {
      const assessed = assessScenarioCoverage({ planning, pack, schedules });
      scenarios.push(assessed.coverage);
      findings.push(...assessed.findings);
    }
  }

  const operatingFindings = findings.filter(
    (entry) =>
      entry.severity === 'blocking' &&
      (entry.domain === 'contract' ||
        entry.domain === 'operating_input' ||
        entry.domain === 'scheduling'),
  );
  const operatingInputValid =
    planning !== null && operatingFindings.length === 0;
  const blockingEnvironmental = findings.some(
    (entry) =>
      entry.domain === 'environmental' && entry.severity === 'blocking',
  );

  let environmental: EnvironmentalAssessment;
  if (planning === null) {
    environmental = assessment(
      'not_assessed',
      'operating_input_invalid',
      scenarios,
      requiredScenarios !== null,
      missingScenarios,
    );
  } else if (packs.length === 0) {
    environmental = assessment(
      'not_assessed',
      'no_environmental_pack_supplied',
      scenarios,
      requiredScenarios !== null,
      missingScenarios,
    );
  } else if (
    blockingEnvironmental ||
    scenarios.some((s) => !s.baseline_covered)
  ) {
    environmental = assessment(
      'insufficient',
      'baseline_or_record_support_incomplete',
      scenarios,
      requiredScenarios !== null,
      missingScenarios,
    );
  } else {
    environmental = assessment(
      'supported',
      null,
      scenarios,
      requiredScenarios !== null,
      missingScenarios,
    );
  }

  const quantifiedAvailable =
    operatingInputValid &&
    environmental.status === 'supported' &&
    scenarios.length > 0;

  const malformed = findings.some(
    (entry) =>
      entry.severity === 'blocking' &&
      (entry.code === FINDING_CODES.malformed_json ||
        entry.code === FINDING_CODES.unsupported_contract_version ||
        entry.code === FINDING_CODES.invalid_contract_shape ||
        entry.code === FINDING_CODES.unknown_property ||
        entry.code === FINDING_CODES.missing_required_field) &&
      entry.domain === 'contract',
  );

  const outcome: InputOutcome = !operatingInputValid
    ? malformed
      ? 'malformed_or_unsupported_input'
      : 'operating_input_invalid'
    : environmental.status === 'supported'
      ? 'admitted_with_supported_coverage'
      : 'admitted_with_environmental_insufficiency';

  return {
    outcome,
    admitted: operatingInputValid,
    operating_input_valid: operatingInputValid,
    quantified_comparison_available: quantifiedAvailable,
    environmental,
    findings,
    transport_status_hint:
      outcome === 'malformed_or_unsupported_input'
        ? 400
        : outcome === 'operating_input_invalid'
          ? 422
          : 200,
    applicability_status: 'not_assessed',
    acceptance_status: 'not_accepted',
    recommendation_eligible: false,
    input_origin: inputOrigin,
    fictional_use: inputOrigin === 'synthetic_fixture',
  };
}

function assessment(
  status: EnvironmentalAssessment['status'],
  reason: string | null,
  scenarios: ScenarioCoverage[],
  requiredDeclared: boolean,
  missingScenarios: string[],
): EnvironmentalAssessment {
  return {
    status,
    reason,
    canonical_unit: CANONICAL_UNIT,
    gap_fill_policy: 'never_zero_never_interpolated_never_indoor_ratio',
    scenarios,
    required_scenarios_declared: requiredDeclared,
    missing_scenarios: missingScenarios,
  };
}
