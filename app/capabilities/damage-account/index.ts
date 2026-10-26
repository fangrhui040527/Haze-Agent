import { z } from 'zod';
import {
  artifactRefSchema,
  boundedJsonSchema,
  type Artifact,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import {
  damageAccountSchema,
  damageCheckSchema,
  damageInputsSchema,
  damageReviewSchema,
  damageRevisionBridgeSchema,
  damageScopeSchema,
  type DamageComponents,
  type DamageInputs,
} from '../../contracts/damage-account.js';
import { canonicalJson } from '../../contracts/json.js';
import { TaskError, type TaskRequest } from '../../contracts/tasks.js';
import type {
  AssignmentDefinition,
  AssignmentOutput,
  AssignmentServices,
  CapabilityDefinition,
  ExecutionMode,
  ToolContext,
  ToolDefinition,
} from '../../orchestration/ports.js';
import {
  DAMAGE_METHODS,
  exactDamageRef,
  normalizeDamageInputs,
} from './inputs.js';
import { compileDamageAccount, assembleDamageAccount } from './methods.js';
import {
  independentlyCheckDamageAccount,
  independentlyCheckDamageRevisionBridge,
} from './checker.js';
import { createDamageRevisionBridge } from './publication.js';

const componentKinds = [
  'damage.scope',
  'damage.inputs',
  'damage.coverage',
  'damage.physical',
  'damage.incidence',
  'damage.welfare',
  'damage.overlap',
  'damage.source-fire-extension',
  'damage.methods',
  'damage.scenarios',
] as const;
const toolSelectionSchema = z.strictObject({
  source_refs: z.array(artifactRefSchema).min(1).max(128),
  method_ids: z
    .array(z.enum(Object.keys(DAMAGE_METHODS) as [string, ...string[]]))
    .min(1)
    .max(32),
});
const revisionSideSchema = z.strictObject({
  input_refs: z.array(artifactRefSchema).min(1).max(64),
  account_ref: artifactRefSchema,
});
const revisionSelectionSchema = z.strictObject({
  previous: revisionSideSchema,
  current: revisionSideSchema,
});

/** Construction/appraisal intent takes precedence over broader PM2.5 and synthesis matches. */
export function matchesDamageAccount(request: TaskRequest): boolean {
  const objective = request.objective;
  if (
    /^\s*(?:please\s+)?(?:explain|summari[sz]e|what|why|how|describe|interpret)\b/i.test(
      objective,
    )
  )
    return false;
  return (
    /(?:build|construct|compile|prepare|create|calculate|produce|estimate|assemble|apprais(?:e|al|ing)|valu(?:e|ation)|account for)\b/i.test(
      objective,
    ) &&
    /(?:damage|harm|welfare|economic loss|avoided loss|damage-account)/i.test(
      objective,
    )
  );
}

export function createDamageAccountCapability(): CapabilityDefinition {
  return {
    card: {
      id: 'damage-account',
      version: 'damage-account.v1',
      purpose:
        'Construct reproducible physical, financial incidence and selected welfare accounts from exact imported quantities and declared unit values; request missing inputs.',
      work_products: [
        ...componentKinds,
        'damage.account',
        'damage.review',
        'damage.revision-bridge',
      ],
      required_tools: [
        'damage.read-input',
        'damage.calculate',
        'damage.reconcile',
        'damage.check',
      ],
      roles: ['HazeOps', 'DamageAccountant', 'EvidenceCritic'],
      readiness: 'implemented',
      limitations: [
        'Imported-input accounting only; no empirical exposure, health-response or source-attribution estimation.',
        'Scientific applicability, legal findings and live-source access are not established by arithmetic review.',
        'Source-fire categories remain explicitly unestimated; no invented default quantities or values.',
      ],
    },
    matches: matchesDamageAccount,
    // Missing inputs are an executable acquisition/gap path, not a reason to route into PM2.5.
    availability: () => ({
      available: true,
      reasons: [
        'Typed JSON/CSV imports with a declared scope, quantities and compatible unit values are required for numerical results.',
      ],
    }),
    prerequisites: [
      {
        definition_id: 'damage.revision-check',
        depends_on_definitions: ['damage.revision-bridge'],
      },
      {
        definition_id: 'damage.scope',
        depends_on_definitions: ['damage.collect'],
      },
      {
        definition_id: 'damage.compile',
        depends_on_definitions: ['damage.collect', 'damage.scope'],
      },
      {
        definition_id: 'damage.assemble',
        depends_on_definitions: [
          'damage.collect',
          'damage.scope',
          'damage.compile',
        ],
      },
      {
        definition_id: 'damage.check',
        depends_on_definitions: [
          'damage.collect',
          'damage.scope',
          'damage.compile',
          'damage.assemble',
        ],
      },
    ],
    review_requirements: [
      'damage.physical',
      'damage.incidence',
      'damage.welfare',
      'damage.scenarios',
      'damage.account',
    ]
      .map((artifact_kind) => ({
        artifact_kind,
        review_definition_id: 'damage.check',
        producer_definition_ids:
          artifact_kind === 'damage.account'
            ? ['damage.assemble']
            : ['damage.compile'],
      }))
      .concat([
        {
          artifact_kind: 'damage.revision-bridge',
          review_definition_id: 'damage.revision-check',
          producer_definition_ids: ['damage.revision-bridge'],
        },
      ]),
    normalizeReview(artifact) {
      if (artifact.kind !== 'damage.review') return undefined;
      const result = damageReviewSchema.safeParse(artifact.content);
      return result.success &&
        result.data.reviewer.assignment_id === artifact.assignment_id &&
        result.data.reviewer.revision === artifact.assignment_revision
        ? {
            verdict: result.data.verdict,
            artifacts: result.data.reviewed_artifacts,
            limitations: result.data.limitations,
          }
        : undefined;
    },
    assignments(request) {
      const input =
        request.scope === undefined
          ? undefined
          : { expected_scope: request.scope };
      return [
        {
          key: 'damage-inputs',
          definition_id: 'damage.collect',
          brief:
            'Read exact authorized JSON/CSV accounting inputs and record their provenance and gaps.',
          depends_on: [],
          input,
        },
        {
          key: 'damage-scope',
          definition_id: 'damage.scope',
          brief:
            'Bind declared account boundaries, endpoints, scenarios and method versions to the exact imports.',
          depends_on: ['damage-inputs'],
          input,
        },
        {
          key: 'damage-components',
          definition_id: 'damage.compile',
          brief:
            'Compile physical, financial incidence and selected welfare views using registered methods.',
          depends_on: ['damage-inputs', 'damage-scope'],
          input,
        },
        {
          key: 'damage-account',
          definition_id: 'damage.assemble',
          brief:
            'Assemble the exact completed component manifest without changing producer artifacts.',
          depends_on: ['damage-inputs', 'damage-scope', 'damage-components'],
          input,
        },
        {
          key: 'damage-review',
          definition_id: 'damage.check',
          brief:
            'Independently reconstruct the account and every component from original pinned imports; disclose applicability limits.',
          depends_on: [
            'damage-inputs',
            'damage-scope',
            'damage-components',
            'damage-account',
          ],
          input,
        },
      ];
    },
  };
}

const sources = (context: ToolContext) =>
  context.inputs.filter((a) => a.producer.kind !== 'assignment');
const selection = (context: ToolContext) => ({
  source_refs: sources(context).map(exactDamageRef),
  method_ids: [...Object.keys(DAMAGE_METHODS)],
});

function selectedInputs(
  input: z.infer<typeof toolSelectionSchema>,
  context: ToolContext,
): DamageInputs {
  const artifacts = input.source_refs.map((ref) => {
    const artifact = sources(context).find(
      (a) =>
        a.id === ref.id && a.version === ref.version && a.sha256 === ref.sha256,
    );
    if (!artifact)
      throw new Error(
        'Damage source reference is not an exact authorized input.',
      );
    return artifact;
  });
  const inputs = normalizeDamageInputs(artifacts);
  if (
    inputs.scope.approved_method_ids.some(
      (id) => !input.method_ids.includes(id),
    )
  )
    throw new Error(
      'The bounded tool selection omits an approved scope method.',
    );
  return inputs;
}

function componentsFrom(context: ToolContext): DamageComponents {
  const components: Record<string, unknown> = {};
  for (const kind of componentKinds) {
    const matches = context.inputs.filter((a) => a.kind === kind);
    if (matches.length !== 1)
      throw new Error(`Expected one exact ${kind} component.`);
    components[kind] = matches[0]!.content;
  }
  return components as DamageComponents;
}

function componentRefs(
  context: ToolContext,
): Record<keyof DamageComponents, ArtifactRef> {
  return Object.fromEntries(
    context.inputs
      .filter((a) => (componentKinds as readonly string[]).includes(a.kind))
      .map((a) => [a.kind, exactDamageRef(a)]),
  ) as Record<keyof DamageComponents, ArtifactRef>;
}

export function createDamageAccountTools(options: {
  mode: ExecutionMode;
}): ToolDefinition[] {
  return [
    {
      id: 'damage.read-input',
      version: '1',
      mode: options.mode,
      description:
        'Normalize exact authorized accounting imports. Numeric inputs must come from retained artifacts.',
      inputSchema: toolSelectionSchema,
      outputSchema: damageInputsSchema,
      execute: (input, context) =>
        Promise.resolve(
          selectedInputs(toolSelectionSchema.parse(input), context),
        ),
    },
    {
      id: 'damage.calculate',
      version: '1',
      mode: options.mode,
      description:
        'Compile registered accounting methods from pinned original imports, never copied numbers or formulas.',
      inputSchema: toolSelectionSchema,
      outputSchema: boundedJsonSchema,
      execute: (input, context) =>
        Promise.resolve(
          boundedJsonSchema.parse(
            compileDamageAccount(
              selectedInputs(toolSelectionSchema.parse(input), context),
            ),
          ),
        ),
    },
    {
      id: 'damage.reconcile',
      version: '1',
      mode: options.mode,
      description:
        'Assemble an account with exact component references after producer completion.',
      inputSchema: toolSelectionSchema,
      outputSchema: damageAccountSchema,
      execute: (input, context) =>
        Promise.resolve(
          assembleDamageAccount(
            selectedInputs(toolSelectionSchema.parse(input), context),
            componentsFrom(context),
            componentRefs(context),
          ),
        ),
    },
    {
      id: 'damage.check',
      version: '1',
      mode: options.mode,
      description:
        'Independently reconstruct quantities, inclusion decisions, incidence and totals from original inputs.',
      inputSchema: toolSelectionSchema,
      outputSchema: damageCheckSchema,
      execute: (input, context) => {
        const accounts = context.inputs.filter(
          (a) => a.kind === 'damage.account',
        );
        if (accounts.length !== 1)
          throw new Error(
            'Independent account review requires exactly one pinned account manifest.',
          );
        const account = accounts[0]!;
        return Promise.resolve(
          independentlyCheckDamageAccount(
            selectedInputs(toolSelectionSchema.parse(input), context),
            componentsFrom(context),
            damageAccountSchema.parse(account.content),
            componentRefs(context),
          ),
        );
      },
    },
  ];
}

function enforceScope(inputs: DamageInputs, assignmentInput: unknown): void {
  const expected = z
    .object({ expected_scope: z.record(z.string(), z.unknown()) })
    .safeParse(assignmentInput);
  if (!expected.success) return;
  // Scope corrections are explicit assertions to check, never permission to relabel imported outcomes.
  for (const [key, value] of Object.entries(expected.data.expected_scope)) {
    if (!Object.hasOwn(damageScopeSchema.shape, key))
      throw new Error(
        `Unknown accounting scope boundary ${key}; import a complete corrected damage scope.`,
      );
    if (
      canonicalJson(value) !==
      canonicalJson(inputs.scope[key as keyof typeof inputs.scope])
    )
      throw new Error(
        `Imported accounting scope conflicts with corrected ${key}; supply matching scoped inputs rather than relabeling old evidence.`,
      );
  }
}

function output(
  artifacts: Artifact[],
  summary: string,
  inputs: DamageInputs,
): AssignmentOutput {
  return {
    status: 'completed',
    summary,
    support: inputs.effects.some((e) => e.quantity !== null)
      ? 'partial'
      : 'gap',
    uncertainty: inputs.limitations,
    outputs: artifacts.map(exactDamageRef),
  };
}
const origin = (inputs: DamageInputs) =>
  inputs.effects.some((e) => e.origin === 'synthetic')
    ? ('synthetic_fixture' as const)
    : ('derived' as const);

export function createDamageAccountAssignments(): AssignmentDefinition[] {
  return [
    {
      id: 'damage.revision-bridge',
      version: '1',
      capability: 'damage-account',
      agent: 'DamageAccountant',
      tools: [],
      instructions:
        'Optional revision branch. Input must contain previous/current {input_refs,account_ref}, all exact authorized artifacts explicitly pinned by the Manager after applicability inspection. Publish a decomposition of quantities, coverage, methods, values and boundary/incidence. Never silently reuse held prior evidence. Requires separate damage.revision-check.',
      execute: (services) => {
        const { previous, current } = revisionInputs(services);
        const bridge = createDamageRevisionBridge(previous, current);
        const artifact = services.save('damage.revision-bridge', bridge, {
          evidence_origin: origin(current.inputs),
        });
        return output(
          [artifact],
          'Published an accounting revision decomposition; price, method and coverage changes are distinct from observed haze changes.',
          current.inputs,
        );
      },
    },
    {
      id: 'damage.revision-check',
      version: '1',
      capability: 'damage-account',
      agent: 'EvidenceCritic',
      tools: [],
      instructions:
        'Independently reconstruct the optional revision bridge from exact original imports for each account. Input previous/current {input_refs,account_ref} must be pinned. Review the exact bridge and retain applicability limits.',
      execute: (services) => {
        const { previous, current } = revisionInputs(services);
        const bridge = services.context.inputs.find(
          (a) => a.kind === 'damage.revision-bridge',
        );
        if (!bridge)
          throw new Error(
            'Missing exact revision bridge for independent review.',
          );
        const check = independentlyCheckDamageRevisionBridge(
          previous,
          current,
          damageRevisionBridgeSchema.parse(bridge.content),
        );
        const review = services.save(
          'damage.review',
          damageReviewSchema.parse({
            schema_version: 'haze.damage.review.v1',
            verdict: check.valid ? 'supported' : 'rejected',
            reviewed_artifacts: [exactDamageRef(bridge)],
            checks: check.checks,
            findings: check.findings,
            limitations: check.limitations,
            applicability: check.applicability,
            reviewer: {
              assignment_id: services.context.assignmentId,
              revision: services.context.assignmentRevision,
            },
          }),
          { evidence_origin: origin(current.inputs) },
        );
        return {
          status: 'completed',
          summary: check.valid
            ? 'Independent revision decomposition passed within its declared accounting basis.'
            : 'Independent revision decomposition rejected.',
          support: check.valid ? 'supported' : 'gap',
          uncertainty: check.limitations,
          outputs: [exactDamageRef(review)],
        };
      },
    },
    {
      id: 'damage.collect',
      version: '1',
      capability: 'damage-account',
      agent: 'HazeOps',
      tools: ['damage.read-input'],
      instructions:
        'Read and normalize original authorized JSON/CSV tables. Ask for missing scope, physical quantities and declared unit values. A source assertion is not scientific acceptance.',
      execute: async (services) => {
        try {
          const inputs = damageInputsSchema.parse(
            await services.tool(
              'damage.read-input',
              selection(services.context),
            ),
          );
          const artifact = services.save('damage.inputs', inputs, {
            evidence_origin: origin(inputs),
          });
          return output(
            [artifact],
            'Normalized exact accounting imports; scientific applicability remains a separate review requirement.',
            inputs,
          );
        } catch (error) {
          return missingInput(services, error);
        }
      },
    },
    {
      id: 'damage.scope',
      version: '1',
      capability: 'damage-account',
      agent: 'DamageAccountant',
      tools: [],
      instructions:
        'Bind exact declared imported boundaries. Never infer a missing boundary or reuse differently scoped evidence after correction.',
      execute: (services) => {
        try {
          const artifact = services.context.inputs.find(
            (a) => a.kind === 'damage.inputs',
          );
          const inputs = damageInputsSchema.parse(artifact?.content);
          enforceScope(inputs, services.input);
          return output(
            [
              services.save('damage.scope', inputs.scope, {
                evidence_origin: origin(inputs),
              }),
            ],
            'Bound declared event, population, periods, social boundary and registered methods.',
            inputs,
          );
        } catch (error) {
          return missingInput(services, error);
        }
      },
    },
    {
      id: 'damage.compile',
      version: '1',
      capability: 'damage-account',
      agent: 'DamageAccountant',
      tools: ['damage.calculate'],
      instructions:
        'Execute registered deterministic methods, preserving exclusions and missingness. Do not add financial transfers to welfare.',
      execute: async (services) => {
        const inputs = normalizeDamageInputs(sources(services.context));
        enforceScope(inputs, services.input);
        const components = (await services.tool(
          'damage.calculate',
          selection(services.context),
        )) as DamageComponents;
        const artifacts = componentKinds
          .filter((k) => !['damage.scope', 'damage.inputs'].includes(k))
          .map((kind) =>
            services.save(kind, components[kind], {
              evidence_origin: origin(inputs),
            }),
          );
        return output(
          artifacts,
          'Compiled separate physical outcomes, financial incidence and selected social welfare; omitted harm remains unestimated.',
          inputs,
        );
      },
    },
    {
      id: 'damage.assemble',
      version: '1',
      capability: 'damage-account',
      agent: 'DamageAccountant',
      tools: ['damage.reconcile'],
      instructions:
        'Publish the manifest only after exact components complete, with envelope dependencies on their outputs. Independent review follows without mutating the manifest.',
      execute: async (services) => {
        const inputs = normalizeDamageInputs(sources(services.context));
        enforceScope(inputs, services.input);
        const account = damageAccountSchema.parse(
          await services.tool('damage.reconcile', selection(services.context)),
        );
        return output(
          [
            services.save('damage.account', account, {
              evidence_origin: origin(inputs),
            }),
          ],
          `Assembled ${account.account_id}: ${account.status}. Exact components require independent review; imported assertions retain applicability limits.`,
          inputs,
        );
      },
    },
    {
      id: 'damage.check',
      version: '1',
      capability: 'damage-account',
      agent: 'EvidenceCritic',
      tools: ['damage.check'],
      instructions:
        'Independently reconstruct from original pinned imports without calling producer valuation or reconciliation arithmetic. Review manifest and direct component inputs; keep arithmetic and scientific applicability separate.',
      execute: async (services) => {
        const inputs = normalizeDamageInputs(sources(services.context));
        enforceScope(inputs, services.input);
        const check = damageCheckSchema.parse(
          await services.tool('damage.check', selection(services.context)),
        );
        const reviewed = services.context.inputs.filter(
          (a) =>
            a.kind === 'damage.account' ||
            (componentKinds as readonly string[]).includes(a.kind),
        );
        const content = damageReviewSchema.parse({
          schema_version: 'haze.damage.review.v1',
          verdict: check.valid ? 'supported' : 'rejected',
          reviewed_artifacts: reviewed.map(exactDamageRef),
          checks: check.checks,
          findings: check.findings,
          limitations: check.limitations,
          applicability: check.applicability,
          reviewer: {
            assignment_id: services.context.assignmentId,
            revision: services.context.assignmentRevision,
          },
        });
        const review = services.save('damage.review', content, {
          evidence_origin: origin(inputs),
        });
        return {
          status: 'completed',
          summary: check.valid
            ? 'Independent accounting reconstruction passed; scientific applicability is not established by arithmetic.'
            : `Independent accounting reconstruction rejected: ${check.findings.join(' ')}`,
          support: check.valid ? 'supported' : 'gap',
          uncertainty: check.limitations,
          outputs: [exactDamageRef(review)],
        };
      },
    },
  ];
}

function revisionInputs(services: AssignmentServices) {
  const selection = revisionSelectionSchema.parse(services.input);
  const side = (value: z.infer<typeof revisionSideSchema>) => {
    const originals = value.input_refs.map((ref) => services.read(ref));
    if (originals.some((artifact) => artifact.producer.kind === 'assignment'))
      throw new Error(
        'Revision bridge original inputs must be authorized imported sources, not producer copies.',
      );
    const account = services.read(value.account_ref);
    if (account.kind !== 'damage.account')
      throw new Error(
        'Revision bridge requires an exact damage.account artifact.',
      );
    return {
      inputs: normalizeDamageInputs(originals),
      account: damageAccountSchema.parse(account.content),
      artifact: value.account_ref,
    };
  };
  return {
    previous: side(selection.previous),
    current: side(selection.current),
  };
}

function missingInput(
  services: AssignmentServices,
  error: unknown,
): AssignmentOutput {
  if (error instanceof TaskError) throw error;
  const reason =
    error instanceof Error
      ? error.message.slice(0, 1800)
      : 'Missing or invalid accounting input.';
  const prompt = `Damage accounting needs typed haze.damage.import.v1 JSON or CSV with one declared scope, source-attributable physical quantities, compatible unit values and coverage. ${reason}`;
  services.question(prompt);
  return {
    status: 'waiting_human',
    summary:
      'Waiting for exact scoped accounting inputs; no estimate has been invented.',
    support: 'gap',
    uncertainty: [reason],
    outputs: [],
  };
}
