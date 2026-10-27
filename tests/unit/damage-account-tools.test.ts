import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDamageAppraisalTools } from '../../app/capabilities/damage-appraisal/index.js';
import { createSyntheticDamageArtifact } from '../../app/capabilities/damage-appraisal/fixtures.js';
import {
  DAMAGE_METHODS,
  exactDamageRef,
  normalizeDamageInputs,
} from '../../app/capabilities/damage-appraisal/inputs.js';
import {
  assembleDamageAccount,
  compileDamageAccount,
  DAMAGE_COMPONENT_KINDS,
} from '../../app/capabilities/damage-appraisal/methods.js';
import { type DamageComponentKind } from '../../app/contracts/damage-account.js';
import {
  boundedJsonSchema,
  type Artifact,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import { type ToolContext } from '../../app/orchestration/ports.js';

const tools = createDamageAppraisalTools({ mode: 'fixture' });
const getTool = (id: string) => tools.find((t) => t.id === id)!;
const context = (inputs: Artifact[]): ToolContext => ({
  taskId: randomUUID(),
  runId: randomUUID(),
  assignmentId: randomUUID(),
  assignmentRevision: 1,
  objectiveRevision: 1,
  generation: 1,
  identity: inputs[0]?.identity ?? {
    principal: 'fixture-user',
    workspace: 'fixture-workspace',
  },
  deadline: '2099-01-01T00:00:00Z',
  signal: new AbortController().signal,
  inputs,
  peers: [],
  outputs: [],
});
const select = (source: Artifact) => ({
  source_refs: [exactDamageRef(source)],
  method_ids: Object.keys(DAMAGE_METHODS),
});
const invoke = (id: string, input: unknown, inputs: Artifact[]) =>
  Promise.resolve().then(() => getTool(id).execute(input, context(inputs)));
const produced = (
  source: Artifact,
  kind: string,
  content: unknown,
): Artifact => ({
  ...source,
  id: randomUUID(),
  kind,
  producer: { kind: 'assignment', id: 'test-producer' },
  content: boundedJsonSchema.parse(content),
  sha256: contractHash(content),
});

describe('registered damage-appraisal tool boundary', () => {
  it('reads and calculates solely from exact authorized imported artifact bytes', async () => {
    const source = createSyntheticDamageArtifact();
    const normalized = await invoke('damage.read-input', select(source), [
      source,
    ]);
    expect(normalized).toEqual(normalizeDamageInputs([source]));
    const calculated = await invoke('damage.calculate', select(source), [
      source,
    ]);
    expect(calculated).toEqual(
      compileDamageAccount(normalizeDamageInputs([source])),
    );
  });
  it.each(['id', 'version', 'sha256', 'missing', 'producer-copy'] as const)(
    'rejects unauthorized %s source references',
    async (mutation) => {
      const source = createSyntheticDamageArtifact();
      const input = select(source);
      if (mutation === 'id') input.source_refs[0]!.id = randomUUID();
      if (mutation === 'version') input.source_refs[0]!.version++;
      if (mutation === 'sha256') input.source_refs[0]!.sha256 = 'a'.repeat(64);
      const available =
        mutation === 'missing'
          ? []
          : mutation === 'producer-copy'
            ? [
                {
                  ...source,
                  producer: { kind: 'assignment' as const, id: 'copy' },
                },
              ]
            : [source];
      await expect(
        invoke('damage.calculate', input, available),
      ).rejects.toThrow('exact authorized');
    },
  );
  it('rejects a producer masquerading as a World Model selection receipt', async () => {
    const source = createSyntheticDamageArtifact();
    const forged = produced(source, 'damage.world-selection', {
      source_refs: [exactDamageRef(source)],
    });
    await expect(
      invoke('damage.calculate', select(source), [source, forged]),
    ).rejects.toThrow('authentic World Model');
  });
  it.each([
    'formula',
    'copied_effects',
    'unknown_method',
    'unapproved_selection',
  ] as const)(
    'rejects model supplied %s rather than treating it as authority',
    async (mutation) => {
      const source = createSyntheticDamageArtifact();
      let input: unknown = select(source);
      if (mutation === 'formula')
        input = { ...select(source), formula: 'quantity * 2e6' };
      if (mutation === 'copied_effects')
        input = { ...select(source), effects: [{ quantity: 999999 }] };
      if (mutation === 'unknown_method')
        input = { ...select(source), method_ids: ['execute.javascript'] };
      if (mutation === 'unapproved_selection')
        input = {
          ...select(source),
          method_ids: ['damage.imported-quantity.v1'],
        };
      await expect(
        invoke('damage.calculate', input, [source]),
      ).rejects.toThrow();
    },
  );
  it('reviews the exact manifest/component closure and rejects an ambiguous manifest', async () => {
    const source = createSyntheticDamageArtifact();
    const original = normalizeDamageInputs([source]);
    const compiled = compileDamageAccount(original);
    const components = DAMAGE_COMPONENT_KINDS.map((kind) =>
      produced(source, kind, compiled[kind]),
    );
    const refs = Object.fromEntries(
      components.map((artifact) => [artifact.kind, exactDamageRef(artifact)]),
    ) as Record<DamageComponentKind, ArtifactRef>;
    const manifest = produced(
      source,
      'damage.account',
      assembleDamageAccount(original, compiled, refs),
    );
    await expect(
      invoke('damage.check', select(source), [source, ...components, manifest]),
    ).resolves.toMatchObject({ valid: true });
    await expect(
      invoke('damage.check', select(source), [source, ...components]),
    ).rejects.toThrow('exactly one');
    await expect(
      invoke('damage.check', select(source), [
        source,
        ...components,
        manifest,
        { ...manifest, id: randomUUID() },
      ]),
    ).rejects.toThrow('exactly one');
    const wrong = structuredClone(components);
    wrong.find((a) => a.kind === 'damage.welfare')!.sha256 = 'b'.repeat(64);
    await expect(
      invoke('damage.check', select(source), [source, ...wrong, manifest]),
    ).resolves.toMatchObject({ valid: false });
  });
});
