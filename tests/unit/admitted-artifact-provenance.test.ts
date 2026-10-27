import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../../app/tasks/store.js';
import { taskRequestSchema } from '../../app/contracts/tasks.js';
import { exactReductionRef } from '../../app/capabilities/damage-reduction-planning/inputs.js';

const identity = {
  principal: 'context-operator',
  workspace: 'context-workspace',
};
const opened: { store: TaskStore; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of opened.splice(0)) {
    store.close();
    const resolved = resolve(directory),
      child = relative(resolve(tmpdir()), resolved);
    if (!child || child.startsWith('..'))
      throw new Error('Unsafe test cleanup.');
    rmSync(resolved, { recursive: true, force: true });
  }
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'haze-context-lineage-'));
  const store = new TaskStore(directory);
  opened.push({ store, directory });
  const owner = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Retain explicit source context.',
    }),
    identity,
    randomUUID(),
    { mode: 'fixture', tools: ['context-proof'] },
  ).task;
  const artifact = store.saveArtifact(owner.id, identity, {
    kind: 'context.example',
    content: { statement: 'Retained supplied material.' },
    producer: { kind: 'service', id: 'test-context' },
    required_tools: ['context-proof'],
  });
  const ref = exactReductionRef(artifact);
  const receiver = (
    explicit = true,
    mode: 'fixture' | 'live' = 'fixture',
    tools = ['context-proof'],
  ) =>
    store.admit(
      taskRequestSchema.parse({
        schema_version: 'haze.task.request.v3',
        objective: 'Use the exact admitted material.',
        context_refs: explicit ? [ref] : [],
      }),
      identity,
      randomUUID(),
      { mode, tools },
    ).task;
  return { store, owner, ref, receiver };
}
describe('explicit admitted artifact producer provenance', () => {
  it('retains exact producer lineage without creating a World Model support pin or acceptance', () => {
    const value = setup(),
      requester = value.receiver();
    expect(
      value.store.worldEvidenceOwner(requester.id, identity, value.ref),
    ).toBeUndefined();
    expect(
      value.store.admittedEvidenceOwner(requester.id, identity, value.ref)?.id,
    ).toBe(value.owner.id);
    expect(
      value.store.worldTaskView(requester.id, identity).current_acceptances,
    ).toEqual([]);
  });
  it('does not treat a mutable applicability mark as an operator context grant', () => {
    const value = setup(),
      requester = value.receiver(false);
    value.store.recordApplicability(
      requester.id,
      identity,
      value.ref,
      true,
      'A mark alone is not an input grant.',
      'test',
    );
    expect(
      value.store.admittedEvidenceOwner(requester.id, identity, value.ref),
    ).toBeUndefined();
  });
  it('withholds foreign provenance after original applicability is withdrawn', () => {
    const value = setup(),
      requester = value.receiver();
    value.store.recordApplicability(
      value.owner.id,
      identity,
      value.ref,
      false,
      'Source no longer applies.',
      'test',
    );
    expect(() =>
      value.store.admittedEvidenceOwner(requester.id, identity, value.ref),
    ).toThrow('no longer current');
  });
  it('rejects cross-mode or missing source grants and active source holds', () => {
    const crossMode = setup();
    expect(() =>
      crossMode.store.admittedEvidenceOwner(
        crossMode.receiver(true, 'live').id,
        identity,
        crossMode.ref,
      ),
    ).toThrow(/mode mismatch|source access/);
    const missingGrant = setup();
    expect(() =>
      missingGrant.store.admittedEvidenceOwner(
        missingGrant.receiver(true, 'fixture', []).id,
        identity,
        missingGrant.ref,
      ),
    ).toThrow('source access');
    const value = setup();
    const requester = value.receiver();
    const scope = { ...identity, mode: 'fixture' as const };
    const record = value.store.world.lookup(scope, {
      kind: 'artifact_reference',
      external_id: `artifact:${value.ref.id}:${value.ref.version}`,
      limit: 2,
    })[0]!;
    value.store.world.hold(
      scope,
      record.ref,
      'Original source was withdrawn.',
      'unknown_impact',
    );
    expect(() =>
      value.store.admittedEvidenceOwner(requester.id, identity, value.ref),
    ).toThrow('held or withdrawn');
  });
});
