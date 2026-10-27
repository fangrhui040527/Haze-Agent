import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createManagerReferenceContract,
  MANAGER_REFERENCE_CONTRACT_VERSION,
} from '../../app/agents/manager/reference-contract.js';
import { managerDecisionSchema } from '../../app/contracts/manager.js';

const ref = {
  id: '11111111-1111-4111-8111-111111111111',
  version: 1,
  sha256: 'a'.repeat(64),
};
const context = () => ({
  artifacts: [],
  request: { context_refs: [] },
  corrections: [],
});
const decision = () => ({
  id: 'decision',
  run_id: '22222222-2222-4222-8222-222222222222',
  generation: 1,
  objective_revision: 1,
  plan_revision: 0,
  event_cursor: 0,
  explanation: 'A general concept needs no artifact evidence.',
  references: [],
  action: {
    type: 'finalize',
    answer: 'An evidence gap is missing support for a claim.',
    sources: [],
    work_products: [],
    uncertainty: [],
    unfinished: [],
  },
});

describe('Manager empty-reference authority boundary', () => {
  it('expands only a model-selected registered plan handle into the pinned canonical plan', () => {
    const templates = [
      {
        key: 'source',
        definition_id: 'test.source',
        brief: 'Inspect the pinned input.',
        depends_on: [],
        input: { source_refs: [ref] },
      },
    ];
    const admitted = {
      ...context(),
      assignments: [],
      capabilities: [
        { card: { id: 'test.capability' }, available: true, templates },
      ],
    };
    const before = structuredClone(admitted);
    const contract = createManagerReferenceContract(admitted);
    const wire = {
      ...decision(),
      action: {
        type: 'apply_plan',
        template: 'plan:test.capability',
        reason: 'This registered workflow addresses the objective.',
      },
    };
    const raw = JSON.stringify(wire);
    expect(contract.schema.parse(wire)).toMatchObject({
      action: {
        type: 'apply_plan',
        assignments: templates,
        retain_assignment_ids: [],
        reason: wire.action.reason,
      },
    });
    expect(
      z.fromJSONSchema(contract.outputSchema).safeParse(wire).success,
    ).toBe(true);
    expect(JSON.stringify(wire)).toBe(raw);
    expect(admitted).toEqual(before);
    expect(
      contract.schema.safeParse({
        ...wire,
        action: { ...wire.action, template: 'plan:unregistered' },
      }).success,
    ).toBe(false);
    expect(
      contract.schema.safeParse({
        ...wire,
        action: { ...wire.action, assignments: templates },
      }).success,
    ).toBe(false);
    const current = createManagerReferenceContract({
      ...admitted,
      assignments: [
        {
          id: ref.id,
          capability: 'test.capability',
          definition_id: 'test.source',
          status: 'queued',
        },
      ],
    });
    expect(current.schema.safeParse(wire).success).toBe(false);
    const unavailable = createManagerReferenceContract({
      ...admitted,
      capabilities: [{ ...admitted.capabilities[0], available: false }],
    });
    expect(unavailable.schema.safeParse(wire).success).toBe(false);
  });
  it('advertises an empty retain list before specialists exist and only eligible existing IDs afterwards', () => {
    const plan = {
      ...decision(),
      action: {
        type: 'apply_plan',
        assignments: [
          {
            key: 'new-source',
            definition_id: 'test.source',
            brief: 'Inspect the input.',
            depends_on: [],
          },
        ],
        retain_assignment_ids: [ref.id],
        reason: 'Admit registered work.',
      },
    };
    const initial = createManagerReferenceContract({
      ...context(),
      assignments: [],
    });
    expect(initial.schema.safeParse(plan).success).toBe(false);
    expect(z.fromJSONSchema(initial.outputSchema).safeParse(plan).success).toBe(
      false,
    );
    const current = createManagerReferenceContract({
      ...context(),
      assignments: [{ id: ref.id, status: 'completed' }],
    });
    expect(current.schema.safeParse(plan).success).toBe(true);
    expect(z.fromJSONSchema(current.outputSchema).safeParse(plan).success).toBe(
      true,
    );
  });
  it('advertises only exact missing registered peer pairs and purposes in both contracts', () => {
    const participants = [
      { assignment_id: '33333333-3333-4333-8333-333333333333', revision: 2 },
      { assignment_id: '44444444-4444-4444-8444-444444444444', revision: 3 },
    ] as const;
    const admitted = {
      ...context(),
      assignments: participants.map((item, index) => ({
        id: item.assignment_id,
        revision: item.revision,
        definition_id: index === 0 ? 'test.produce' : 'test.review',
        status: 'queued',
      })),
      capabilities: [
        {
          peer_requirements: [
            {
              definitions: ['test.produce', 'test.review'],
              purpose: 'numerical-check',
            },
          ],
        },
      ],
      peer_grants: [],
    };
    const original = structuredClone(admitted);
    const contract = createManagerReferenceContract(admitted);
    const provider = z.fromJSONSchema(contract.outputSchema);
    for (const order of [participants, [...participants].reverse()]) {
      const value = {
        ...decision(),
        action: {
          type: 'coordinate',
          participants: order,
          purpose: 'numerical-check',
        },
      };
      expect(contract.schema.safeParse(value).success).toBe(true);
      expect(provider.safeParse(value).success).toBe(true);
    }
    const wrong = {
      ...decision(),
      action: {
        type: 'coordinate',
        participants,
        purpose: 'A paraphrased description',
      },
    };
    expect(contract.schema.safeParse(wrong).success).toBe(false);
    expect(provider.safeParse(wrong).success).toBe(false);
    expect(admitted).toEqual(original);
    const granted = createManagerReferenceContract({
      ...admitted,
      peer_grants: [{ participants, purpose: 'numerical-check' }],
    });
    const duplicate = {
      ...decision(),
      action: { type: 'coordinate', participants, purpose: 'numerical-check' },
    };
    expect(granted.schema.safeParse(duplicate).success).toBe(false);
    // Zod's JSON-schema importer cannot evaluate `not`; providers receive the
    // standard JSON-schema exclusion while the local contract enforces it.
    expect(JSON.stringify(granted.outputSchema)).toContain('"not":');
    expect(JSON.stringify(granted.outputSchema)).toContain(
      '"const":"numerical-check"',
    );
    expect(
      granted.schema.safeParse({
        ...decision(),
        action: { type: 'wait', reason: 'Admitted work is progressing.' },
      }).success,
    ).toBe(true);
  });
  it('permits an unsourced concept answer without changing context, schema or output', () => {
    const admitted = context();
    const original = structuredClone(admitted);
    const baseJSON = z.toJSONSchema(managerDecisionSchema);
    const beforeSchema = JSON.stringify(baseJSON);
    const value = decision();
    const beforeValue = JSON.stringify(value);
    const contract = createManagerReferenceContract(
      admitted,
      managerDecisionSchema,
      baseJSON,
    );
    expect(contract.constrained).toBe(true);
    expect(contract.version).toBe(MANAGER_REFERENCE_CONTRACT_VERSION);
    expect(contract.schema.parse(value)).toEqual(value);
    expect(z.fromJSONSchema(contract.outputSchema).parse(value)).toEqual(value);
    expect(admitted).toEqual(original);
    expect(JSON.stringify(baseJSON)).toBe(beforeSchema);
    expect(JSON.stringify(value)).toBe(beforeValue);
  });

  it.each(['references', 'sources', 'work_products'] as const)(
    'rejects invented %s in both local and provider contracts without repairing it',
    (position) => {
      const contract = createManagerReferenceContract(context());
      const value = decision();
      if (position === 'references')
        Object.assign(value, { references: [ref] });
      else Object.assign(value.action, { [position]: [ref] });
      const raw = JSON.stringify(value);
      expect(contract.schema.safeParse(value).success).toBe(false);
      expect(
        z.fromJSONSchema(contract.outputSchema).safeParse(value).success,
      ).toBe(false);
      expect(JSON.stringify(value)).toBe(raw);
    },
  );

  it.each([
    {},
    { request: { context_refs: [] }, corrections: [] },
    { artifacts: [], request: {}, corrections: [] },
    { artifacts: [], request: { context_refs: [] } },
    { ...context(), artifacts: [{ ref }] },
    { ...context(), request: { context_refs: [ref] } },
    { ...context(), corrections: [{ context_refs: [ref] }] },
    { ...context(), inspections: [{ artifact: ref }] },
    { ...context(), reviews: [{ artifact: { id: ref.id } }] },
    { ...context(), events: [{ data: { retained: ref } }] },
    {
      ...context(),
      events: [{ data: { retained: { ...ref, kind: 'source.import' } } }],
    },
    { ...context(), context_status: { truncated: true } },
    { ...context(), context_status: { omitted_artifacts: 1 } },
    { ...context(), context_status: { omitted_events: 1 } },
    { ...context(), context_status: { missing: ['Source omitted.'] } },
  ])(
    'preserves the base contract when absence is not established (%j)',
    (admitted) => {
      const baseJSON = z.toJSONSchema(managerDecisionSchema);
      const contract = createManagerReferenceContract(
        admitted,
        managerDecisionSchema,
        baseJSON,
      );
      expect(contract.constrained).toBe(false);
      expect(contract.schema.parse(decision())).toEqual(
        managerDecisionSchema.parse(decision()),
      );
      if (contract.referenceCatalog.length) {
        expect(contract.referenceCatalog[0]).toMatchObject({
          handle: 'ref:1',
          ref,
        });
        expect(contract.outputSchema === baseJSON).toBe(false);
      } else {
        expect(contract.schema === managerDecisionSchema).toBe(true);
        expect(contract.outputSchema === baseJSON).toBe(true);
      }
    },
  );

  it('accepts corrections that explicitly introduce no references', () => {
    const contract = createManagerReferenceContract({
      ...context(),
      corrections: [{ message: 'Explain the concept.', context_refs: [] }],
    });
    expect(contract.constrained).toBe(true);
    expect(contract.schema.safeParse(decision()).success).toBe(true);
  });

  it('preserves stronger custom constraints and root-local reference scope', () => {
    const custom = managerDecisionSchema.extend({
      id: z.literal('custom-decision'),
      explanation: z.string().min(30),
    });
    const baseJSON = z.toJSONSchema(custom, { reused: 'ref' });
    expect(JSON.stringify(baseJSON)).toContain('#/$defs/');
    const contract = createManagerReferenceContract(
      context(),
      custom,
      baseJSON,
    );
    const provider = z.fromJSONSchema(contract.outputSchema);
    const value = { ...decision(), id: 'custom-decision' };
    expect(contract.schema.safeParse(value).success).toBe(true);
    expect(provider.safeParse(value).success).toBe(true);
    expect(contract.outputSchema.$defs).toEqual(baseJSON.$defs);
    for (const invalid of [
      { ...value, id: 'different' },
      { ...value, explanation: 'Too short.' },
      { ...value, references: [ref] },
    ]) {
      expect(contract.schema.safeParse(invalid).success).toBe(false);
      expect(provider.safeParse(invalid).success).toBe(false);
    }
  });

  it('retains other legal action shapes', () => {
    const contract = createManagerReferenceContract(context());
    const provider = z.fromJSONSchema(contract.outputSchema);
    for (const action of [
      { type: 'question', prompt: 'Which report should I summarize?' },
      { type: 'wait', reason: 'An admitted operation is still running.' },
      { type: 'lookup', tool: 'read-only.lookup', input: {} },
      { type: 'inspect', artifacts: [ref] },
    ]) {
      const value = { ...decision(), action };
      expect(contract.schema.safeParse(value).success).toBe(true);
      expect(provider.safeParse(value).success).toBe(true);
    }
  });
});

describe('Manager pinned reference wire handles', () => {
  it('advertises registered review refs for inspection and support but excludes them from final factual selections', () => {
    const product = {
      ...ref,
      id: '33333333-3333-4333-8333-333333333333',
      sha256: 'b'.repeat(64),
    };
    const review = {
      ...ref,
      id: '44444444-4444-4444-8444-444444444444',
      sha256: 'c'.repeat(64),
    };
    const contract = createManagerReferenceContract({
      ...context(),
      request: { context_refs: [ref] },
      artifacts: [
        { ref, kind: 'source.import' },
        { ref: product, kind: 'analysis' },
        { ref: review, kind: 'review' },
      ],
      reviews: [{ artifact: product, review_artifact: review }],
    });
    expect(
      contract.referenceCatalog.find((entry) => entry.ref.id === review.id)
        ?.support_only,
    ).toBe(true);
    expect(
      contract.referenceCatalog.find((entry) => entry.ref.id === product.id)
        ?.support_only,
    ).toBeUndefined();
    const wire = {
      ...decision(),
      references: ['ref:3'],
      action: {
        ...decision().action,
        answer: 'The result follows from the input [ref:1].',
        sources: ['ref:1'],
        work_products: ['ref:2'],
      },
    };
    const advertised = z.fromJSONSchema(contract.outputSchema);
    expect(advertised.safeParse(wire).success).toBe(true);
    expect(
      advertised.safeParse({
        ...wire,
        action: { ...wire.action, work_products: ['ref:3'] },
      }).success,
    ).toBe(false);
    expect(
      advertised.safeParse({
        ...wire,
        action: { ...wire.action, sources: ['ref:3'] },
      }).success,
    ).toBe(false);
    const inspect = {
      ...decision(),
      action: { type: 'inspect', artifacts: ['ref:3'] },
    };
    expect(advertised.safeParse(inspect).success).toBe(true);
    expect(contract.schema.parse(inspect).action).toMatchObject({
      artifacts: [review],
    });
    // Canonical parsing does not rewrite a wrong selection; existing runtime authority still rejects it.
    expect(
      contract.schema.parse({
        ...wire,
        action: { ...wire.action, work_products: ['ref:3'] },
      }).action,
    ).toMatchObject({ work_products: [review] });
  });

  it('advertises empty factual selection arrays when only registered review support is pinned', () => {
    const contract = createManagerReferenceContract({
      ...context(),
      artifacts: [{ ref, kind: 'review' }],
      reviews: [{ review_artifact: ref }],
    });
    const advertised = z.fromJSONSchema(contract.outputSchema);
    expect(
      advertised.safeParse({ ...decision(), references: ['ref:1'] }).success,
    ).toBe(true);
    expect(
      advertised.safeParse({
        ...decision(),
        action: { ...decision().action, work_products: ['ref:1'] },
      }).success,
    ).toBe(false);
  });

  it('renders only explicitly selected source citation handles, independent of catalog ordinal', () => {
    const secondImport = {
      ...ref,
      id: '33333333-3333-4333-8333-333333333333',
      sha256: 'b'.repeat(64),
    };
    const product = {
      ...ref,
      id: '44444444-4444-4444-8444-444444444444',
      sha256: 'c'.repeat(64),
    };
    const capture = {
      ...ref,
      id: '55555555-5555-4555-8555-555555555555',
      sha256: 'd'.repeat(64),
    };
    const pinned = {
      ...context(),
      request: { context_refs: [ref, secondImport] },
      artifacts: [
        { ref, kind: 'source.import' },
        { ref: secondImport, kind: 'source.import' },
        { ref: product, kind: 'analysis' },
        { ref: capture, kind: 'pm25.capture' },
      ],
    };
    const contract = createManagerReferenceContract(pinned);
    const wire = {
      ...decision(),
      action: {
        ...decision().action,
        answer:
          'The capture [ref:4] and the second import [ref:2] support the scoped claim.',
        sources: ['ref:4', 'ref:2'],
        work_products: ['ref:3'],
      },
    };
    expect(contract.schema.parse(wire).action).toMatchObject({
      answer:
        'The capture [E1] and the second import [S1] support the scoped claim.',
      sources: [capture, secondImport],
      work_products: [product],
    });
    expect(wire.action.answer).toContain('[ref:4]');
    expect(
      contract.schema.safeParse({
        ...wire,
        action: {
          ...wire.action,
          answer: 'A work product [ref:3] is not a selected source. [S1]',
        },
      }).success,
    ).toBe(false);
    expect(
      contract.schema.safeParse({
        ...wire,
        action: { ...wire.action, answer: 'Unknown [ref:999]. [S1]' },
      }).success,
    ).toBe(false);
    expect(
      contract.schema.parse({
        ...wire,
        action: { ...wire.action, answer: 'A claim without a citation.' },
      }).action,
    ).toMatchObject({ answer: 'A claim without a citation.' });
    expect(JSON.stringify(contract.outputSchema)).toContain(
      'Cite selected action.sources',
    );
  });

  it('uses the admitted compact import class and refuses to infer an unknown source class', () => {
    const admitted = { ...context(), request: { context_refs: [ref] } };
    const wire = {
      ...decision(),
      action: {
        ...decision().action,
        answer: 'Selected import [ref:1].',
        sources: ['ref:1'],
      },
    };
    expect(
      createManagerReferenceContract({
        ...admitted,
        current_import_context_ref_indices: [0],
      }).schema.parse(wire).action,
    ).toMatchObject({ answer: 'Selected import [S1].' });
    expect(
      createManagerReferenceContract(admitted).schema.safeParse(wire).success,
    ).toBe(false);
  });

  it('expands selected handles into exact canonical refs and advertises only handles on the wire', () => {
    const pinned = { ...context(), artifacts: [{ ref, kind: 'analysis' }] };
    const original = structuredClone(pinned);
    const contract = createManagerReferenceContract(pinned);
    const wire = {
      ...decision(),
      references: ['ref:1'],
      action: {
        ...decision().action,
        answer: 'The retained result supports this scoped claim. [E1]',
        work_products: ['ref:1'],
        sources: ['ref:1'],
      },
    };
    expect(
      z.fromJSONSchema(contract.outputSchema).safeParse(wire).success,
    ).toBe(true);
    expect(contract.schema.parse(wire)).toMatchObject({
      references: [ref],
      action: { work_products: [ref], sources: [ref] },
    });
    const canonical = {
      ...wire,
      references: [ref],
      action: { ...wire.action, work_products: [ref], sources: [ref] },
    };
    expect(contract.schema.safeParse(canonical).success).toBe(true);
    expect(
      z.fromJSONSchema(contract.outputSchema).safeParse(canonical).success,
    ).toBe(false);
    expect(pinned).toEqual(original);
    expect(wire.references).toEqual(['ref:1']);
  });

  it('rejects unknown handles and leaves prose and arbitrary assignment inputs unchanged', () => {
    const contract = createManagerReferenceContract({
      ...context(),
      request: { context_refs: [ref] },
    });
    const prose = {
      ...decision(),
      action: { ...decision().action, answer: 'ref:1' },
    };
    expect(contract.schema.parse(prose).action).toMatchObject({
      answer: 'ref:1',
    });
    expect(
      contract.schema.safeParse({ ...prose, references: ['ref:999'] }).success,
    ).toBe(false);
    expect(
      contract.schema.safeParse({
        ...prose,
        references: [{ ...ref, sha256: 'a'.repeat(63) }],
      }).success,
    ).toBe(false);
    expect(
      contract.schema.parse({
        ...prose,
        references: [{ ...ref, sha256: 'b'.repeat(64) }],
      }).references,
    ).toEqual([{ ...ref, sha256: 'b'.repeat(64) }]);
    const plan = {
      ...decision(),
      action: {
        type: 'apply_plan',
        assignments: [
          {
            key: 'a',
            definition_id: 'test',
            brief: 'Inspect input.',
            depends_on: [],
            input: { literal: 'ref:1' },
          },
        ],
        retain_assignment_ids: [],
        reason: 'Inspect scoped data.',
      },
    };
    expect(contract.schema.parse(plan).action).toMatchObject({
      assignments: [{ input: { literal: 'ref:1' } }],
    });
  });

  it('resolves references through local JSON Schema definitions', () => {
    const reference = z.strictObject({
      id: z.uuid(),
      version: z.int().positive(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    });
    const schema = z.strictObject({ selected: z.array(reference) });
    const output: z.core.JSONSchema.JSONSchema = {
      type: 'object',
      $defs: { pinned: z.toJSONSchema(reference) },
      properties: {
        selected: { type: 'array', items: { $ref: '#/$defs/pinned' } },
      },
      required: ['selected'],
      additionalProperties: false,
    };
    const contract = createManagerReferenceContract(
      { ...context(), request: { context_refs: [ref] } },
      schema,
      output,
    );
    expect(contract.schema.parse({ selected: ['ref:1'] })).toEqual({
      selected: [ref],
    });
    expect(
      z.fromJSONSchema(contract.outputSchema).safeParse({ selected: ['ref:1'] })
        .success,
    ).toBe(true);
  });
});
