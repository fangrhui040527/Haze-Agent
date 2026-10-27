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
      expect(contract.schema).toBe(managerDecisionSchema);
      expect(contract.outputSchema).toBe(baseJSON);
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
