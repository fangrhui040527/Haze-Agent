import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSpecialistActionContract } from '../../app/orchestration/action-contract.js';
import { agentActionSchema } from '../../app/orchestration/contracts.js';
import { artifactRefSchema } from '../../app/contracts/artifacts.js';

const artifact = {
  id: '11111111-1111-4111-8111-111111111111',
  version: 2,
  sha256: 'a'.repeat(64),
};
const jobId = '22222222-2222-4222-8222-222222222222';
const otherJobId = '33333333-3333-4333-8333-333333333333';
const finish = (overrides: Record<string, unknown> = {}) => ({
  id: 'deliver',
  type: 'finish',
  summary: 'Retained account delivered with its review limitation.',
  support: 'partial',
  uncertainty: ['Independent review is unavailable.'],
  outputs: [artifact],
  ...overrides,
});
const message = (recipient = 'reviewer-1') => ({
  id: 'inform-reviewer',
  type: 'message',
  recipient,
  purpose: 'clarify',
  text: 'The exact authorized revision is ready for checking.',
});
const wait = (jobIds: string[]) => ({
  id: 'wait-for-owned-jobs',
  type: 'external_wait',
  schema_version: 'haze.external.wait.action.v1',
  dependencies: jobIds.map((job_id) => ({ job_id, required: true })),
});
const providerSchema = (
  contract: ReturnType<typeof createSpecialistActionContract>,
) => z.fromJSONSchema(contract.outputSchema);

describe('specialist action choices derived from admitted context', () => {
  it('offers no tool, peer, external wait, escalation or generic save without grants', () => {
    const contract = createSpecialistActionContract({});
    for (const type of [
      'tool',
      'message',
      'wait',
      'external_wait',
      'escalate',
      'save',
      'save_tool_result',
    ]) {
      expect(contract.allowedActions).not.toContain(type);
    }
    expect(contract.schema.safeParse(message()).success).toBe(false);
    expect(contract.schema.safeParse(wait([jobId])).success).toBe(false);
    expect(
      contract.schema.safeParse({
        id: 'invented-method',
        type: 'tool',
        tool: 'ungranted.lookup',
        input: {},
      }).success,
    ).toBe(false);
    expect(contract.allowedActions).toContain('question');
    expect(contract.allowedActions).toContain('finish');
  });

  it('binds tools and their argument contracts in runtime and provider-facing schemas', () => {
    const contract = createSpecialistActionContract({
      tools: [
        {
          id: 'registered.lookup',
          input_schema: {
            type: 'object',
            properties: { town: { type: 'string', minLength: 1 } },
            required: ['town'],
            additionalProperties: false,
          },
        },
      ],
    });
    const granted = {
      id: 'lookup',
      type: 'tool',
      tool: 'registered.lookup',
      input: { town: 'Admitted Town' },
    };
    const invalid = [
      { ...granted, tool: 'ungranted.lookup' },
      { ...granted, input: { town: 42 } },
      { ...granted, input: { town: 'Admitted Town', sql: 'arbitrary code' } },
    ];
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(granted).success).toBe(true);
      for (const action of invalid)
        expect(schema.safeParse(action).success).toBe(false);
    }
  });

  it('permits messages only to named admitted peer instances', () => {
    const contract = createSpecialistActionContract({
      peers: [
        { id: 'reviewer-1', definition_id: 'independent.check', revision: 2 },
      ],
    });
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(message()).success).toBe(true);
      expect(schema.safeParse(message('EvidenceCritic')).success).toBe(false);
      expect(schema.safeParse(message('invented-peer')).success).toBe(false);
    }
    expect(contract.allowedActions).toContain('wait');
  });

  it('permits a host-authorized peer wait without granting peer messaging', () => {
    const contract = createSpecialistActionContract({
      peers: [],
      peer_wait_available: true,
    });
    expect(contract.allowedActions).toContain('wait');
    expect(contract.allowedActions).not.toContain('message');
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(
        schema.safeParse({ id: 'await-coordination', type: 'wait' }).success,
      ).toBe(true);
      expect(schema.safeParse(message()).success).toBe(false);
    }
    expect(
      createSpecialistActionContract({
        peers: [],
        peer_wait_available: false,
      }).allowedActions,
    ).not.toContain('wait');
  });

  it('permits generic saves only for explicitly declared artifact kinds', () => {
    const action = {
      id: 'record-gap',
      type: 'save',
      kind: 'evidence.gap',
      content: { reason: 'Required source unavailable.' },
    };
    const absent = createSpecialistActionContract({});
    const granted = createSpecialistActionContract({
      artifact_kinds: ['evidence.gap'],
    });
    for (const schema of [absent.schema, providerSchema(absent)])
      expect(schema.safeParse(action).success).toBe(false);
    for (const schema of [granted.schema, providerSchema(granted)]) {
      expect(schema.safeParse(action).success).toBe(true);
      expect(
        schema.safeParse({ ...action, kind: 'fabricated.capture' }).success,
      ).toBe(false);
    }
  });

  it('saves only a completed retained result under its declared artifact kind', () => {
    const contract = createSpecialistActionContract({
      tool_results: [
        {
          action_id: 'source-result',
          status: 'completed',
          artifact_kind: 'pm25.capture',
        },
        {
          action_id: 'failed-source',
          status: 'failed',
          artifact_kind: 'pm25.capture',
        },
        {
          action_id: 'running-source',
          status: 'running',
          artifact_kind: 'pm25.capture',
        },
      ],
    });
    const action = {
      id: 'retain',
      type: 'save_tool_result',
      tool_action_id: 'source-result',
      kind: 'pm25.capture',
    };
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(action).success).toBe(true);
      expect(
        schema.safeParse({ ...action, kind: 'pm25.analysis' }).success,
      ).toBe(false);
      for (const id of ['failed-source', 'running-source', 'invented-source'])
        expect(
          schema.safeParse({ ...action, tool_action_id: id }).success,
        ).toBe(false);
    }
  });

  it('does not infer a completed result from pending or malformed metadata', () => {
    const contract = createSpecialistActionContract({
      tool_results: [
        { action_id: 'not-received', status: 'pending' },
        { status: 'completed', artifact_kind: 'pm25.capture' },
      ],
    });
    expect(contract.allowedActions).not.toContain('save_tool_result');
  });
});

describe('exact references and truthful completion', () => {
  it('permits reading pinned and shared inputs while finishing only with owned outputs', () => {
    const shared = {
      id: '44444444-4444-4444-8444-444444444444',
      version: 1,
      sha256: 'b'.repeat(64),
    };
    const owned = {
      id: '55555555-5555-4555-8555-555555555555',
      version: 3,
      sha256: 'c'.repeat(64),
    };
    const context = {
      inputs: [artifact],
      shared_refs: [shared],
      tools: [
        {
          id: 'registered.check',
          input_schema: {
            type: 'object',
            properties: { artifact: z.toJSONSchema(artifactRefSchema) },
            required: ['artifact'],
            additionalProperties: false,
          },
        },
      ],
    };
    const readOnly = createSpecialistActionContract({
      ...context,
      owned_outputs: [],
    });
    for (const [parser, schema] of [
      ['runtime', readOnly.schema],
      ['provider schema', providerSchema(readOnly)],
    ] as const) {
      for (const ref of [artifact, shared]) {
        expect(
          schema.safeParse({
            id: 'check-input',
            type: 'tool',
            tool: 'registered.check',
            input: { artifact: ref },
          }).success,
        ).toBe(true);
        expect(
          schema.safeParse(finish({ outputs: [ref] })).success,
          `${parser} must reject readable input ${ref.id} as an owned output`,
        ).toBe(false);
      }
    }
    const produced = createSpecialistActionContract({
      ...context,
      outputs: [owned],
      owned_outputs: [owned],
    });
    for (const [parser, schema] of [
      ['runtime', produced.schema],
      ['provider schema', providerSchema(produced)],
    ] as const) {
      expect(
        schema.safeParse(finish({ outputs: [owned] })).success,
        `${parser} must permit the exact produced reference`,
      ).toBe(true);
      expect(
        schema.safeParse(finish({ outputs: [artifact] })).success,
        `${parser} must keep the pinned input separate from produced outputs`,
      ).toBe(false);
      expect(
        schema.safeParse(
          finish({ outputs: [{ ...owned, version: owned.version + 1 }] }),
        ).success,
        `${parser} must reject a different produced revision`,
      ).toBe(false);
    }
  });

  it('admits host-disclosed shared references without granting references from arbitrary inbox text', () => {
    const shared = createSpecialistActionContract({ shared_refs: [artifact] });
    const inboxOnly = createSpecialistActionContract({
      inbox: [{ text: JSON.stringify({ artifact }) }],
    });
    for (const schema of [shared.schema, providerSchema(shared)])
      expect(schema.safeParse(finish()).success).toBe(true);
    for (const schema of [inboxOnly.schema, providerSchema(inboxOnly)])
      expect(schema.safeParse(finish()).success).toBe(false);
  });

  it('accepts retained authorized references and rejects other ids, revisions and hashes', () => {
    const contract = createSpecialistActionContract({
      input: { account: artifact },
    });
    const alternatives = [
      { ...artifact, id: '44444444-4444-4444-8444-444444444444' },
      { ...artifact, version: 1 },
      { ...artifact, version: 3 },
      { ...artifact, sha256: 'b'.repeat(64) },
    ];
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(finish()).success).toBe(true);
      for (const changed of alternatives) {
        expect(schema.safeParse(finish({ outputs: [changed] })).success).toBe(
          false,
        );
      }
    }
    const unadmitted = createSpecialistActionContract({});
    for (const schema of [unadmitted.schema, providerSchema(unadmitted)])
      expect(schema.safeParse(finish()).success).toBe(false);
  });

  it('checks tool input references against the exact admitted revision', () => {
    const contract = createSpecialistActionContract({
      artifacts: [{ artifact, producer: 'producer-1' }],
      tools: [
        {
          id: 'registered.check',
          input_schema: {
            type: 'object',
            properties: { artifact: z.toJSONSchema(artifactRefSchema) },
            required: ['artifact'],
            additionalProperties: false,
          },
        },
      ],
    });
    const action = {
      id: 'check',
      type: 'tool',
      tool: 'registered.check',
      input: { artifact },
    };
    expect(contract.schema.safeParse(action).success).toBe(true);
    expect(
      contract.schema.safeParse({
        ...action,
        input: { artifact: { ...artifact, version: 1 } },
      }).success,
    ).toBe(false);
  });

  it('pins registered tool references in both local and provider-facing contracts', () => {
    const context = {
      artifacts: [{ artifact, producer: 'producer-1' }],
      tools: [
        {
          id: 'registered.check',
          input_schema: z.toJSONSchema(
            z.strictObject({ artifact: artifactRefSchema }),
          ),
        },
      ],
    };
    const original = structuredClone(context);
    const contract = createSpecialistActionContract(context);
    expect(context).toEqual(original);
    const action = {
      id: 'check',
      type: 'tool',
      tool: 'registered.check',
      input: { artifact },
    };
    const changedReferences = [
      { ...artifact, id: jobId },
      { ...artifact, version: 1 },
      { ...artifact, sha256: 'b'.repeat(64) },
      { ...artifact, sha256: 'a'.repeat(63) },
      { ...artifact, id: 'not-an-artifact-id' },
    ];
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(action).success).toBe(true);
      for (const changed of changedReferences)
        expect(
          schema.safeParse({ ...action, input: { artifact: changed } }).success,
        ).toBe(false);
      expect(
        schema.safeParse({
          ...action,
          input: {
            artifact_id: artifact.id,
            artifact_version: artifact.version,
            artifact_sha256: artifact.sha256.slice(0, -2),
          },
        }).success,
      ).toBe(false);
    }
  });

  it.each(['inline', 'local reference'] as const)(
    'binds nested local definitions with %s constraints without changing tool fields',
    (constraint) => {
      const earlier = { ...artifact, version: 1 };
      const refJSON = z.toJSONSchema(artifactRefSchema);
      const contract = createSpecialistActionContract({
        artifacts: [artifact, earlier],
        tools: [
          {
            id: 'registered.batch-check',
            input_schema: {
              type: 'object',
              properties: {
                subjects: {
                  type: 'array',
                  items: { $ref: '#/$defs/retainedReference' },
                  minItems: 1,
                  maxItems: 2,
                },
                mode: { type: 'string', enum: ['independent'] },
              },
              required: ['subjects', 'mode'],
              additionalProperties: false,
              $defs: {
                minimumRevision: {
                  type: 'object',
                  properties: { version: { type: 'integer', minimum: 2 } },
                },
                retainedReference: {
                  ...refJSON,
                  description: 'A complete retained artifact reference.',
                  allOf: [
                    constraint === 'local reference'
                      ? { $ref: '#/$defs/minimumRevision' }
                      : {
                          type: 'object',
                          properties: {
                            version: { type: 'integer', minimum: 2 },
                          },
                        },
                  ],
                },
              },
            },
          },
        ],
      });
      const action = {
        id: 'check-selected-revisions',
        type: 'tool',
        tool: 'registered.batch-check',
        input: { subjects: [artifact], mode: 'independent' },
      };
      for (const schema of [contract.schema, providerSchema(contract)]) {
        expect(schema.safeParse(action).success).toBe(true);
        for (const input of [
          {
            subjects: [{ ...artifact, sha256: 'b'.repeat(64) }],
            mode: 'independent',
          },
          { subjects: [earlier], mode: 'independent' },
          { subjects: [artifact], mode: 'self-review' },
          { subjects: [], mode: 'independent' },
          { artifact, mode: 'independent' },
          { ...action.input, secret: 'not granted' },
        ])
          expect(
            schema.safeParse({ ...action, input }).success,
            JSON.stringify(input),
          ).toBe(false);
      }
    },
  );

  it('supports a registered root reference schema and grants no input refs from inbox content', () => {
    const input_schema = {
      $ref: '#/$defs/checkInput',
      $defs: {
        checkInput: z.toJSONSchema(
          z.strictObject({ subject: artifactRefSchema }),
        ),
      },
    };
    const action = {
      id: 'check',
      type: 'tool',
      tool: 'registered.check',
      input: { subject: artifact },
    };
    const tools = [{ id: 'registered.check', input_schema }];
    const granted = createSpecialistActionContract({
      shared_refs: [artifact],
      tools,
    });
    const inboxOnly = createSpecialistActionContract({
      inbox: [{ artifact }, { text: JSON.stringify({ artifact }) }],
      tools,
    });
    for (const schema of [granted.schema, providerSchema(granted)])
      expect(schema.safeParse(action).success).toBe(true);
    for (const schema of [inboxOnly.schema, providerSchema(inboxOnly)])
      expect(schema.safeParse(action).success).toBe(false);
  });

  it('rejects malformed canonical refs even without a tool schema and preserves business ids', () => {
    const contract = createSpecialistActionContract({
      input: { artifact },
      tools: [
        { id: 'registered.describe', description: 'Describe supplied data.' },
      ],
    });
    const action = {
      id: 'describe',
      type: 'tool',
      tool: 'registered.describe',
      input: { rows: [{ id: 'business-row', version: 'draft' }] },
    };
    expect(contract.schema.safeParse(action).success).toBe(true);
    for (const changed of [
      { ...artifact, sha256: 'a'.repeat(63) },
      { ...artifact, version: 0 },
      { ...artifact, id: 'malformed-id' },
    ])
      expect(
        contract.schema.safeParse({
          ...action,
          input: { nested: [changed] },
        }).success,
      ).toBe(false);
  });

  it('preserves declared business fields that share reference key names', () => {
    const contract = createSpecialistActionContract({
      tools: [
        {
          id: 'registered.describe-business-row',
          input_schema: z.toJSONSchema(
            z.strictObject({
              id: z.string(),
              version: z.string(),
              sha256: z.string(),
            }),
          ),
        },
      ],
    });
    const action = {
      id: 'describe-business-row',
      type: 'tool',
      tool: 'registered.describe-business-row',
      input: { id: 'business-row', version: 'draft', sha256: 'pending' },
    };
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(action).success).toBe(true);
      expect(
        schema.safeParse({ ...action, input: { ...action.input, version: 2 } })
          .success,
      ).toBe(false);
    }
  });

  it('shares reference choices across tool positions within the admitted input budget', () => {
    const refs = Array.from({ length: 12 }, (_, index) => ({
      id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
      version: 2,
      sha256: (index + 1).toString(16).padStart(64, '0'),
    }));
    const input_schema = {
      type: 'object',
      properties: {
        source: { $ref: '#/$defs/retained' },
        targets: {
          type: 'array',
          items: { $ref: '#/$defs/retained' },
          minItems: 1,
          maxItems: 3,
        },
        batch: {
          type: 'object',
          properties: { artifact: { $ref: '#/$defs/retained' } },
          required: ['artifact'],
          additionalProperties: false,
        },
      },
      required: ['source', 'targets', 'batch'],
      additionalProperties: false,
      $defs: { retained: z.toJSONSchema(artifactRefSchema) },
    };
    const tools = Array.from({ length: 8 }, (_, index) => ({
      id: `registered.compare-${index}`,
      input_schema,
    }));
    const context = { tools, artifacts: refs, owned_outputs: [] };
    const contract = createSpecialistActionContract(context);
    const serialized = JSON.stringify(contract.outputSchema);
    const definitions = contract.outputSchema.$defs as Record<string, unknown>;
    const choices = Object.keys(definitions).filter((name) =>
      name.startsWith('hazeAdmittedArtifactReference'),
    );
    expect(choices).toHaveLength(1);
    for (const ref of refs)
      expect(serialized.split(ref.sha256)).toHaveLength(2);
    expect(
      Buffer.byteLength(
        JSON.stringify({ context, output_schema: contract.outputSchema }),
      ),
    ).toBeLessThan(24_576);
    const smaller = createSpecialistActionContract({
      ...context,
      artifacts: refs.slice(0, 4),
    });
    expect(
      Buffer.byteLength(serialized) -
        Buffer.byteLength(JSON.stringify(smaller.outputSchema)),
    ).toBeLessThan(2048);
    const action = {
      id: 'compare-retained',
      type: 'tool',
      tool: tools[0]!.id,
      input: {
        source: refs[0],
        targets: [refs[1]],
        batch: { artifact: refs[2] },
      },
    };
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(action).success).toBe(true);
      expect(
        schema.safeParse({
          ...action,
          input: {
            ...action.input,
            batch: { artifact: { ...refs[2], sha256: 'f'.repeat(64) } },
          },
        }).success,
      ).toBe(false);
    }
  });

  it.each(['partial', 'gap'])(
    'requires a stated limitation for %s support',
    (support) => {
      const contract = createSpecialistActionContract({ outputs: [artifact] });
      expect(contract.schema.safeParse(finish({ support })).success).toBe(true);
      for (const uncertainty of [[], [''], ['  ']])
        expect(
          contract.schema.safeParse(finish({ support, uncertainty })).success,
        ).toBe(false);
    },
  );

  it('retains supported completion without inventing a limitation', () => {
    const contract = createSpecialistActionContract({ outputs: [artifact] });
    expect(
      contract.schema.safeParse(
        finish({ support: 'supported', uncertainty: [] }),
      ).success,
    ).toBe(true);
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(
        schema.safeParse(finish({ support: 'The source is unavailable.' }))
          .success,
      ).toBe(false);
      expect(schema.safeParse({ ...finish(), extra: true }).success).toBe(
        false,
      );
    }
  });
});

describe('acknowledged external dependencies and narrower role contracts', () => {
  it('uses only valid acknowledged handles and rejects duplicate or invented jobs', () => {
    const contract = createSpecialistActionContract({
      acknowledged_jobs: [
        { job_id: jobId, remote_acknowledged: true },
        { job_id: otherJobId, remote_acknowledged: false },
        { job_id: 'producer-assignment', remote_acknowledged: true },
      ],
    });
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(wait([jobId])).success).toBe(true);
      expect(schema.safeParse(wait([otherJobId])).success).toBe(false);
      expect(schema.safeParse(wait(['producer-assignment'])).success).toBe(
        false,
      );
    }
    expect(contract.schema.safeParse(wait([jobId, jobId])).success).toBe(false);
    expect(
      createSpecialistActionContract({
        acknowledged_jobs: [{ job_id: jobId, remote_acknowledged: false }],
      }).allowedActions,
    ).not.toContain('external_wait');
  });

  it('preserves a finish-only base contract in both validation and model suggestions', () => {
    const finishOnly = agentActionSchema.options.find(
      (option) => option.shape.type.value === 'finish',
    )!;
    const contract = createSpecialistActionContract(
      {
        tools: [{ id: 'registered.lookup' }],
        peers: [{ id: 'reviewer-1' }],
        acknowledged_jobs: [{ job_id: jobId, remote_acknowledged: true }],
        artifact_kinds: ['evidence.gap'],
        outputs: [artifact],
        escalation_available: true,
      },
      finishOnly,
    );
    expect(contract.allowedActions).toEqual(['finish']);
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(finish()).success).toBe(true);
      expect(schema.safeParse(message()).success).toBe(false);
      expect(schema.safeParse(wait([jobId])).success).toBe(false);
      expect(
        schema.safeParse({
          id: 'question',
          type: 'question',
          prompt: 'What town?',
        }).success,
      ).toBe(false);
    }
  });

  it('preserves narrower base fields in the provider-facing output contract', () => {
    const gapOnly = z.strictObject({
      id: z.string().min(1),
      type: z.literal('finish'),
      summary: z.string().min(1),
      support: z.literal('gap'),
      uncertainty: z.array(z.string().min(1)).min(1),
      outputs: z.array(artifactRefSchema).max(0),
    });
    const contract = createSpecialistActionContract(
      { artifacts: [artifact] },
      gapOnly,
    );
    const gap = finish({ support: 'gap', outputs: [] });
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(gap).success).toBe(true);
      expect(schema.safeParse({ ...gap, support: 'partial' }).success).toBe(
        false,
      );
      expect(schema.safeParse({ ...gap, outputs: [artifact] }).success).toBe(
        false,
      );
      expect(schema.safeParse({ ...gap, uncertainty: [] }).success).toBe(false);
    }
  });

  it('preserves root-local references in a narrower base contract', () => {
    const detail: z.ZodType = z.lazy(() =>
      z.strictObject({ label: z.string(), children: z.array(detail) }),
    );
    const finishOnly = agentActionSchema.options.find(
      (option) => option.shape.type.value === 'finish',
    )!;
    const base = finishOnly.extend({ detail: detail.optional() });
    const baseJSON = z.toJSONSchema(base);
    expect(baseJSON.$defs).toBeDefined();
    const contract = createSpecialistActionContract(
      { outputs: [artifact] },
      base,
    );
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(finish()).success).toBe(true);
      expect(
        schema.safeParse(finish({ outputs: [{ ...artifact, version: 1 }] }))
          .success,
      ).toBe(false);
      expect(schema.safeParse(message()).success).toBe(false);
    }
  });

  it('preserves policy-local references for recursive registered inputs with a custom base', () => {
    const tree: z.ZodType = z.lazy(() =>
      z.strictObject({ label: z.string(), children: z.array(tree) }),
    );
    const detail: z.ZodType = z.lazy(() =>
      z.strictObject({
        label: z.literal('base-only'),
        children: z.array(detail),
      }),
    );
    const toolOnly = agentActionSchema.options.find(
      (option) => option.shape.type.value === 'tool',
    )!;
    const base = toolOnly.extend({ detail: detail.optional() });
    const contract = createSpecialistActionContract(
      {
        tools: [
          {
            id: 'registered.describe-tree',
            input_schema: z.toJSONSchema(tree),
          },
        ],
      },
      base,
    );
    const action = {
      id: 'describe-tree',
      type: 'tool',
      tool: 'registered.describe-tree',
      input: { label: 'Root', children: [{ label: 'Leaf', children: [] }] },
    };
    expect(Object.keys(contract.outputSchema.$defs as object)).toHaveLength(2);
    for (const schema of [contract.schema, providerSchema(contract)]) {
      expect(schema.safeParse(action).success).toBe(true);
      expect(
        schema.safeParse({ ...action, tool: 'ungranted.describe-tree' })
          .success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...action, input: { label: 42, children: [] } })
          .success,
      ).toBe(false);
      expect(schema.safeParse(finish({ outputs: [] })).success).toBe(false);
    }
  });
});
