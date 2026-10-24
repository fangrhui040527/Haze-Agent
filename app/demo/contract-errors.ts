import {
  ContractError,
  contractHash,
  parseContractJson,
  validateContract,
  type ContractKind,
  type ExecutionSurface,
  type ImmutableReference,
  type PlanningBundle,
} from '../contracts/index.js';

export interface ContractErrorExample {
  id: string;
  boundary: 'contract' | 'json' | 'reference';
  contract: ContractKind | null;
  surface: ExecutionSurface;
  payload: unknown;
  expected_code: string;
  proposed_http_status: number;
  note: string;
}

/** Byte integrity is required in addition to shape validation; grants no acceptance. */
export function verifyDemoReference(
  ref: ImmutableReference,
  bytes: unknown,
): void {
  if (!ref.id.startsWith('demo:')) throw new Error('demo_reference_required');
  if (ref.sha256 !== contractHash(bytes))
    throw new Error('reference_hash_mismatch');
}

export function buildContractErrorExamples(
  bundle: PlanningBundle,
): ContractErrorExample[] {
  const request = {
    schema_version: 'haze.run.v2',
    programme_id: bundle.programme_id,
    input: {
      operation: 'plan_outdoor_work',
      problem_id: bundle.problem_id,
      bundle_ref: {
        id: 'demo:review-errors-bundle',
        revision: 1,
        sha256: contractHash(bundle),
      },
    },
  };
  const draft = {
    schema_version: 'haze.input_draft.v1',
    id: 'demo:review-input-draft',
    revision: 1,
    state: 'draft',
    proposed_fields: { programme_id: bundle.programme_id },
    diagnostics: [
      {
        field_path: '/crew',
        reason: {
          code: 'attestation_missing',
          explanation: 'An authorized ordinary crew/work record is missing.',
        },
      },
    ],
    accepted_bundle_ref: null,
    acceptance: 'not_accepted',
  };
  validateContract('input_draft', draft);
  const occupancy = structuredClone(bundle);
  occupancy.baseline.assignments[1]!.start = '2026-10-25T09:15:00+08:00';
  return [
    {
      id: 'unsupported-v1',
      boundary: 'contract',
      contract: 'run',
      surface: 'historical_harness',
      payload: { ...request, schema_version: 'haze.run.v1' },
      expected_code: 'unsupported_contract_version',
      proposed_http_status: 400,
      note: 'Explicit importer migration required; no silent v1 reinterpretation.',
    },
    {
      id: 'inline-mode-override',
      boundary: 'contract',
      contract: 'run',
      surface: 'historical_harness',
      payload: { ...request, input: { ...request.input, mode: 'live' } },
      expected_code: 'invalid_contract',
      proposed_http_status: 400,
      note: 'Run callers supply bounded intent, not mode or accepted operating facts.',
    },
    {
      id: 'draft-is-not-admission',
      boundary: 'contract',
      contract: 'run',
      surface: 'historical_harness',
      payload: draft,
      expected_code: 'unsupported_contract_version',
      proposed_http_status: 400,
      note: 'Draft input remains diagnostics only; it cannot stand in for a bundle or admitted run.',
    },
    {
      id: 'baseline-occupancy-gap',
      boundary: 'contract',
      contract: 'planning',
      surface: 'historical_harness',
      payload: occupancy,
      expected_code: 'invalid_contract',
      proposed_http_status: 422,
      note: 'Worker occupancy, overlap and precedence are checked before any comparison.',
    },
    {
      id: 'demo-ref-on-canonical',
      boundary: 'contract',
      contract: 'run',
      surface: 'canonical',
      payload: request,
      expected_code: 'demo_reference_requires_historical_harness',
      proposed_http_status: 422,
      note: 'The public canonical contract cannot acquire authority from demo-local hashes.',
    },
    {
      id: 'duplicate-key',
      boundary: 'json',
      contract: null,
      surface: 'historical_harness',
      payload:
        '{"schema_version":"haze.run.v1","schema_version":"haze.run.v2"}',
      expected_code: 'duplicate_json_key',
      proposed_http_status: 400,
      note: 'Reject duplicates before a JSON parser can discard the first value.',
    },
    {
      id: 'tampered-reference-bytes',
      boundary: 'reference',
      contract: null,
      surface: 'historical_harness',
      payload: {
        ref: request.input.bundle_ref,
        record: { ...bundle, problem_id: 'tampered' },
      },
      expected_code: 'reference_hash_mismatch',
      proposed_http_status: 409,
      note: 'Illustrative adapter mapping only: this repo has no HTTP route or authorization service.',
    },
  ];
}

/** Replay the saved examples against the actual validators; examples are not stored answers. */
export function replayContractErrorExamples(
  examples: ContractErrorExample[],
): void {
  for (const example of examples) {
    let observed = 'no_error';
    try {
      if (example.boundary === 'json') {
        if (typeof example.payload !== 'string')
          throw new Error('invalid_example');
        parseContractJson(example.payload);
      } else if (example.boundary === 'reference') {
        const payload = example.payload as {
          ref: ImmutableReference;
          record: unknown;
        };
        verifyDemoReference(payload.ref, payload.record);
      } else {
        if (!example.contract) throw new Error('invalid_example');
        validateContract(example.contract, example.payload, example.surface);
      }
    } catch (error) {
      observed =
        error instanceof ContractError
          ? error.code
          : error instanceof Error
            ? error.message.split(' at JSON offset ')[0]!
            : 'unknown_error';
    }
    if (observed !== example.expected_code)
      throw new Error(`error_example_mismatch:${example.id}:${observed}`);
  }
}
