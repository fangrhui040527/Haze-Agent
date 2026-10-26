import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactRef } from '../../app/contracts/artifacts.js';
import { TaskStore } from '../../app/tasks/store.js';

const identity = { principal: 'pin-test-user', workspace: 'pin-test-space' };
const scope = { ...identity, mode: 'fixture' as const };
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const exact = (artifact: ArtifactRef): ArtifactRef => ({
  id: artifact.id,
  version: artifact.version,
  sha256: artifact.sha256,
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'haze-world-pins-'));
  const store = new TaskStore(directory, { recover: false });
  cleanup.push(() => {
    store.close();
    const rel = relative(resolve(tmpdir()), resolve(directory));
    if (!rel || rel.startsWith('..') || rel.includes(':'))
      throw new Error('Unsafe cleanup path.');
    rmSync(directory, { recursive: true, force: true });
  });
  const importSource = (name: string) =>
    store.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: name + '.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from(name).toString('base64'),
      },
      identity,
      name,
    ).artifact;
  const source = importSource('retained-source');
  const explicit = importSource('explicit-source');
  const producer = store.admit(
    {
      schema_version: 'haze.task.request.v3',
      objective: 'Retain supporting evidence.',
      context_refs: [exact(source)],
      constraints: [],
      desired_deliverables: [],
    },
    identity,
    'producer',
    { mode: 'fixture' },
  ).task;
  const capture = store.saveArtifact(producer.id, identity, {
    kind: 'test.retained-capture',
    content: { retained: true },
    producer: { kind: 'service', id: 'test-ingestor' },
    dependencies: [exact(source)],
    generation: producer.generation,
  });
  const task = store.admit(
    {
      schema_version: 'haze.task.request.v3',
      objective: 'Reuse retained evidence.',
      context_refs: [exact(explicit)],
      constraints: [],
      desired_deliverables: [],
    },
    identity,
    'consumer',
    { mode: 'fixture' },
  ).task;
  const collector = store.createAssignments(
    task.id,
    task.current_run_id,
    task.objective_revision,
    [
      {
        role: 'HazeOps',
        capability: 'test',
        definition_id: 'test.collect',
        definition_version: '1',
        brief: 'Collect retained context.',
        inputs: [exact(explicit)],
      },
    ],
  )[0]!;
  store.acquireAssignment(task.id, collector.id);
  const record = store.world.projectArtifact(capture, task.mode).value;
  store.pinWorldContext(
    task.id,
    identity,
    collector.id,
    task.generation,
    [exact(capture), exact(source)],
    'Build from exact retained evidence.',
    record.ref.id,
  );
  return { store, task, source, capture, explicit, collector, record };
}

describe('World Model pinned evidence lifecycle', () => {
  it('still rejects explicit self prerequisites and cycles inferred between assignments', () => {
    const { store, task, collector } = setup();
    const selfId = randomUUID();
    const definition = {
      role: 'HazeOps' as const,
      capability: 'test',
      definition_id: 'test.follow-on',
      definition_version: '1',
      brief: 'Review retained context.',
    };
    expect(() =>
      store.createAssignments(
        task.id,
        task.current_run_id,
        task.objective_revision,
        [{ ...definition, id: selfId, dependencies: [selfId] }],
      ),
    ).toThrow('Assignment graph must be acyclic');
    const peer = store.createAssignments(
      task.id,
      task.current_run_id,
      task.objective_revision,
      [definition],
    )[0]!;
    store.acquireAssignment(task.id, peer.id);
    const a = store.saveArtifact(task.id, identity, {
      kind: 'test.independent-observation',
      content: { observer: 'a' },
      producer: { kind: 'assignment', id: collector.id },
      generation: task.generation,
    });
    const b = store.saveArtifact(task.id, identity, {
      kind: 'test.independent-observation',
      content: { observer: 'b' },
      producer: { kind: 'assignment', id: peer.id },
      generation: task.generation,
    });
    store.pinAssignmentInput(task.id, collector.id, task.generation, exact(b));
    store.pinAssignmentInput(task.id, peer.id, task.generation, exact(a));
    expect(() =>
      store.createAssignments(
        task.id,
        task.current_run_id,
        task.objective_revision,
        [],
      ),
    ).toThrow('Assignment graph must be acyclic');
  });

  it('rechecks late holds on original sources even while the selected capture is unheld', () => {
    const { store, task, source, capture, record } = setup();
    expect(() =>
      store.revalidateWorldEvidence(task.id, identity, exact(source)),
    ).not.toThrow();
    const sourceRecord = store.world.projectArtifact(source, task.mode).value;
    const hold = store.world.hold(
      scope,
      sourceRecord.ref,
      'Original evidence requires a correction.',
      'correction',
    );
    expect(store.world.activeHolds(scope, record.ref.id)).toHaveLength(0);
    expect(() =>
      store.revalidateWorldEvidence(task.id, identity, exact(capture)),
    ).not.toThrow();
    expect(() =>
      store.revalidateWorldEvidence(task.id, identity, exact(source)),
    ).toThrow('Pinned World Model evidence is revised or held');
    store.world.clearHold(scope, hold.id, 'Correction independently checked.');
    expect(() =>
      store.revalidateWorldEvidence(task.id, identity, exact(source)),
    ).not.toThrow();
  });

  it('removes historical retrieved receipts and supports from a corrected branch while preserving explicit inputs', () => {
    const { store, task, source, capture, explicit, collector } = setup();
    const snapshot = store.saveArtifact(task.id, identity, {
      kind: 'test.context-snapshot',
      content: { captured: true },
      producer: { kind: 'assignment', id: collector.id },
      dependencies: [exact(capture), exact(source)],
      generation: task.generation,
    });
    const receipt = store.saveArtifact(task.id, identity, {
      kind: 'test.selection-receipt',
      content: { selected: true },
      producer: { kind: 'service', id: 'test-resolver' },
      dependencies: [exact(capture), exact(source), exact(snapshot)],
      generation: task.generation,
    });
    store.pinAssignmentInput(
      task.id,
      collector.id,
      task.generation,
      exact(receipt),
    );
    // Follow-on work remains admissible while the collector retains its own
    // immutable snapshot through the service selection receipt.
    const downstream = store.createAssignments(
      task.id,
      task.current_run_id,
      task.objective_revision,
      [
        {
          role: 'HazeOps',
          capability: 'test',
          definition_id: 'test.consume',
          definition_version: '1',
          brief: 'Use retrieved selection.',
          dependencies: [collector.id],
          inputs: [exact(receipt), exact(source), exact(explicit)],
        },
      ],
    )[0]!;
    const before = store.read(task.id, identity);
    store.update(task.id, identity, 'correct-scope', {
      schema_version: 'haze.task.update.v3',
      expected_objective_revision: before.objective_revision,
      expected_run_id: before.current_run_id,
      expected_generation: before.generation,
      expected_state_revision: before.state_revision,
      kind: 'correction',
      passage: 'Use a revised time period.',
      affected_assignment_ids: [collector.id],
    });
    const revised = store.read(task.id, identity);
    expect(
      revised.assignments
        .find((current) => current.id === collector.id)!
        .inputs.some((ref) => ref.id === receipt.id),
    ).toBe(false);
    expect(() =>
      store.createAssignments(
        task.id,
        revised.current_run_id,
        revised.objective_revision,
        [],
      ),
    ).not.toThrow();
    for (const artifact of revised.artifacts)
      store.recordApplicability(
        task.id,
        identity,
        artifact.artifact,
        true,
        'Manager inspected the retained references against the correction.',
        'Manager',
      );
    store.acquireAssignment(task.id, collector.id);
    store.clearWorldContextPins(
      task.id,
      identity,
      collector.id,
      revised.generation,
    );
    const current = store.read(task.id, identity);
    for (const id of [collector.id, downstream.id])
      expect(current.assignments.find((a) => a.id === id)!.inputs).toEqual([
        exact(explicit),
      ]);
    expect(
      store.db
        .prepare(
          'SELECT COUNT(*) AS count FROM world_task_pins WHERE task_id=?',
        )
        .get(task.id),
    ).toEqual({ count: 1 });
  });
});
