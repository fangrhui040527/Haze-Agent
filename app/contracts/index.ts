import { z } from 'zod';
import { canonicalJson, CANONICAL_SERIALIZER_VERSION } from './json.js';
import { planningSchema, planningShape, runSchema } from './planning.js';
import { resultSchema, resultShape } from './result.js';
import { HANDOFF_VERSIONS, handoffSchemas, handoffShapes } from './handoffs.js';

export { planningSchema, planningShape, runSchema } from './planning.js';
export { resultSchema, resultShape } from './result.js';
export type { PlanningBundle, Activity, RunRequest } from './planning.js';
export type { Result } from './result.js';
export type { ImmutableReference } from './common.js';
export {
  HANDOFF_VERSIONS,
  handoffSchemas,
  handoffShapes,
  sourceLocatorShape,
} from './handoffs.js';
export type {
  HandoffKind,
  EvidenceHandoff,
  ScenarioHandoff,
  PolicyHandoff,
  SnapshotHandoff,
  InputDraftHandoff,
  PlannerInputHandoff,
  CalculationHandoff,
  IndependentCheckHandoff,
  WorkerShieldInputHandoff,
} from './handoffs.js';
export {
  parseContractJson,
  canonicalJson,
  contractHash,
  CANONICAL_SERIALIZER_VERSION,
} from './json.js';
export { CONTRACT_LIMITS } from './common.js';

export const CONTRACT_VERSIONS = {
  planning: 'haze.planning.v2',
  run: 'haze.run.v2',
  result: 'haze.result.v2',
  ...HANDOFF_VERSIONS,
} as const;
export type ContractKind = keyof typeof CONTRACT_VERSIONS;
export type ExecutionSurface = 'canonical' | 'historical_harness';

export class ContractError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: unknown,
  ) {
    super(code);
    this.name = 'ContractError';
  }
}

/** Validation is a local engineering check; it never accepts evidence or admits a run. */
export function validateContract(
  kind: ContractKind,
  value: unknown,
  surface: ExecutionSurface = 'canonical',
) {
  canonicalJson(value);
  const version =
    typeof value === 'object' && value !== null && 'schema_version' in value
      ? value.schema_version
      : undefined;
  if (version !== CONTRACT_VERSIONS[kind]) {
    throw new ContractError('unsupported_contract_version', {
      supported_versions: [CONTRACT_VERSIONS[kind]],
    });
  }
  const schemas: Record<ContractKind, z.ZodType> = {
    planning: planningSchema,
    run: runSchema,
    result: resultSchema,
    ...handoffSchemas,
  };
  const schema = schemas[kind];
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      'invalid_contract',
      parsed.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  if (kind === 'run') {
    const request = runSchema.parse(parsed.data);
    if (
      surface === 'canonical' &&
      request.input.bundle_ref.id.startsWith('demo:')
    ) {
      throw new ContractError('demo_reference_requires_historical_harness', {
        path: ['input', 'bundle_ref', 'id'],
      });
    }
  }
  return parsed.data;
}

/** Structural schemas deliberately leave cross-record predicates to validateContract. */
export function exportContractSchemas() {
  const shapes = {
    planning: planningShape,
    run: runSchema,
    result: resultShape,
    ...handoffShapes,
  };
  return Object.fromEntries(
    (Object.keys(shapes) as ContractKind[]).map(
      (kind) =>
        [
          CONTRACT_VERSIONS[kind],
          {
            ...z.toJSONSchema(shapes[kind], { target: 'draft-2020-12' }),
            $id: `urn:haze:schema:${CONTRACT_VERSIONS[kind]}`,
            title: CONTRACT_VERSIONS[kind],
            description:
              'Haze architecture v0.13 structural contract. Also run the runtime semantic validator; a schema pass grants no operating authority.',
            'x-canonical-serializer': CANONICAL_SERIALIZER_VERSION,
          },
        ] as const,
    ),
  );
}
