import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore, type AssignmentDefinition } from '../../app/tasks/store.js';
import type { ManagerDecision } from '../../app/contracts/manager.js';

const identity = { principal: 'trace-test', workspace: 'trace-test' };
const roots: string[] = [];
const stores: TaskStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.isOpen) store.close();
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (!rel || rel.startsWith('..')) throw new Error('Unsafe test directory.');
    rmSync(root, { recursive: true, force: true });
  }
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'haze-trace-capture-'));
  roots.push(root);
  const store = new TaskStore(root, { recover: false });
  stores.push(store);
  const task = store.admit(
    {
      schema_version: 'haze.task.request.v3',
      objective: 'Trace fixture evidence.',
      context_refs: [],
      constraints: [],
      desired_deliverables: [],
    },
    identity,
    randomUUID(),
    {
      mode: 'fixture',
      tools: [],
      limits: { max_model_calls: 12, max_assignments: 12 },
    },
  ).task;
  return { root, store, task };
}
const definition = (
  role: AssignmentDefinition['role'] = 'HazeOps',
): AssignmentDefinition => ({
  role,
  definition_id: `test.${role}`,
  definition_version: '1',
  capability: 'test',
  brief: 'Evaluate fixture evidence.',
});

describe('durable trace capture', () => {
  it('retains concise original input and saved-result summaries without extra model calls', () => {
    const { store, task } = setup();
    expect(store.readTraceBatch()[0]?.input_summary).toBe(
      'Trace fixture evidence.',
    );
    const answer = 'Fixture finding. '.repeat(200);
    store.saveResult(task.id, task.current_run_id, task.generation, {
      schema_version: 'haze.task.result.v3',
      answer,
      completion: 'full',
      work_products: [],
      sources: [],
      covered_scope: {},
      uncertainty: [],
      review: {
        status: 'not_required',
        scope: 'No independent evidence claim.',
        limitations: [],
      },
      currency: 'current',
      next_requirements: [],
      provenance: {
        mode: 'fixture',
        model_calls: 0,
        tool_calls: 0,
        capabilities: [],
        receipts: [],
      },
    });
    expect(store.readTraceBatch().at(-1)).toMatchObject({
      action: 'task_completed',
      output_summary: answer.slice(0, 2000),
    });
    expect(store.readTraceBatch().at(-1)?.output_summary).toHaveLength(2000);
    expect(store.read(task.id, identity).usage.model_calls).toBe(0);
  });

  it('commits one immutable envelope per task event and notifies only after commit', () => {
    const { store, task } = setup();
    const notify = vi.fn(() =>
      expect(
        store.db.prepare('SELECT COUNT(*) AS n FROM trace_records').get(),
      ).toEqual({ n: 2 }),
    );
    store.onTraceCommitted(notify);
    store.transaction(() => {
      const event = store.appendEvent(
        task.id,
        'fixture_step',
        'Runtime',
        'Fixture committed.',
      );
      expect(store.readTraceBatch().at(-1)?.event_id).toBe(
        `trace:${event.cursor}`,
      );
      expect(notify).not.toHaveBeenCalled();
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(
      store.listTraceRecords(task.id, task.current_run_id, identity),
    ).toHaveLength(2);
  });

  it('rolls back envelopes and notifications with transactions and savepoints', () => {
    const { store, task } = setup();
    const notify = vi.fn();
    store.onTraceCommitted(notify);
    expect(() =>
      store.transaction(() => {
        store.appendEvent(
          task.id,
          'rolled_back',
          'Runtime',
          'Never committed.',
        );
        throw new Error('abort');
      }),
    ).toThrow('abort');
    store.transaction(() => {
      expect(() =>
        store.transaction(() => {
          store.appendEvent(
            task.id,
            'savepoint_rolled_back',
            'Runtime',
            'Never committed.',
          );
          throw new Error('savepoint');
        }),
      ).toThrow('savepoint');
      store.appendEvent(task.id, 'kept', 'Runtime', 'Committed.');
    });
    expect(store.readTraceBatch().map((trace) => trace.action)).toEqual([
      'task_admitted',
      'kept',
    ]);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('captures task events inserted by extension stores in the same transaction', () => {
    const { store, task } = setup();
    store.transaction(() => {
      store.db.prepare('INSERT INTO events(task_id,body) VALUES(?,?)').run(
        task.id,
        JSON.stringify({
          schema_version: 'haze.task.event.v3',
          task_id: task.id,
          run_id: task.current_run_id,
          objective_revision: 1,
          generation: 1,
          at: new Date().toISOString(),
          type: 'extension_fact',
          actor: 'Runtime',
          message: 'Extension fact.',
        }),
      );
    });
    expect(store.readTraceBatch().at(-1)?.action).toBe('extension_fact');
    expect(store.readTraceBatch().at(-1)?.provenance.capture).toBe('native');
  });

  it('retains committed records across reopen and reconstructs old gaps explicitly', () => {
    const { root, store, task } = setup();
    store.appendEvent(
      task.id,
      'persisted',
      'Runtime',
      'Persisted native fact.',
    );
    const original = store.readTraceBatch().at(-1)!;
    store.db.prepare('DELETE FROM trace_records WHERE cursor=1').run();
    store.close();
    const reopened = new TaskStore(root, { recover: false });
    stores.push(reopened);
    const records = reopened.listTraceRecords(
      task.id,
      task.current_run_id,
      identity,
    );
    expect(records.at(-1)).toEqual(original);
    expect(records[0]?.provenance.capture).toBe('reconstructed');
    expect(records[0]?.provenance.omissions).not.toHaveLength(0);
    expect(() =>
      reopened.listTraceRecords(task.id, task.current_run_id, {
        principal: 'foreign',
        workspace: 'trace-test',
      }),
    ).toThrow('Task not found');
  });

  it('keeps attempts independent from plan revisions and links receipts to their charge', () => {
    const { store, task } = setup();
    const assignment = store.createAssignments(
      task.id,
      task.current_run_id,
      1,
      [definition()],
    )[0]!;
    store.acquireAssignment(task.id, assignment.id);
    const attempt = store.chargeAttempt(task.id, assignment.id, 'model');
    const charge = store.readTraceBatch().at(-1)!;
    store.completeAttempt(task.id, attempt.id, {
      output: { answer: 'fixture' },
      receipt: { provider: 'fixture', model: 'fixture-v1' },
    });
    const receipt = store.readTraceBatch().at(-1)!;
    expect(receipt.causes.event_ids).toContain(charge.event_id);
    expect(receipt.assignment_revision).toBe(1);
    expect(receipt.attempt_number).toBe(1);
    expect(receipt.execution_accepted).toBe(true);
    expect(receipt.details).toMatchObject({
      attempt: { receipt: { provider: 'fixture', model: 'fixture-v1' } },
    });
  });

  it('preserves failed decisions after rolling back their partial mutations', () => {
    const { store, task } = setup();
    const decision: ManagerDecision = {
      id: randomUUID(),
      run_id: task.current_run_id,
      generation: 1,
      objective_revision: 1,
      plan_revision: 0,
      event_cursor: 1,
      explanation: 'Fixture failed dispatch.',
      references: [],
      action: { type: 'wait', reason: 'Wait.' },
    };
    expect(() =>
      store.applyManagerDecision(task.id, decision, () => {
        store.appendEvent(
          task.id,
          'partial_mutation',
          'Manager',
          'Must roll back.',
        );
        throw new Error('controlled dispatch failure');
      }),
    ).toThrow('controlled dispatch failure');
    const records = store.readTraceBatch();
    expect(records.some((trace) => trace.action === 'partial_mutation')).toBe(
      false,
    );
    expect(records.at(-1)).toMatchObject({
      action: 'manager_decision_failed',
      causes: { decision_id: decision.id },
    });
    expect(
      store.managerStateForRun(task.id, task.current_run_id, identity)
        ?.decisions,
    ).toHaveLength(0);
  });

  it('resolves peer IDs to actual roles and keeps exact artifact references', () => {
    const { store, task } = setup();
    const assignments = store.createAssignments(
      task.id,
      task.current_run_id,
      1,
      [definition(), definition('EvidenceCritic')],
    );
    const channel = store.openPeerChannel(
      task.id,
      task.current_run_id,
      'Fixture peer feedback.',
      assignments.map((a) => a.id),
    );
    store.acquireAssignment(task.id, assignments[0]!.id);
    const message = store.sendPeerMessage(
      task.id,
      channel.id,
      assignments[0]!.id,
      assignments[1]!.id,
      'Recheck the source.',
      randomUUID(),
    );
    expect(store.readTraceBatch().at(-1)).toMatchObject({
      peer: { sender_role: 'HazeOps', recipient_role: 'EvidenceCritic' },
      causes: { message_id: message.id },
    });
    const artifact = store.saveArtifact(task.id, identity, {
      kind: 'fixture.evidence',
      content: { value: 7 },
      producer: { kind: 'service', id: 'fixture' },
      evidence_origin: 'synthetic_fixture',
    });
    expect(store.readTraceBatch().at(-1)?.artifacts).toContainEqual({
      id: artifact.id,
      version: artifact.version,
      sha256: artifact.sha256,
    });
  });

  it('deduplicates exact independent verdicts and captures replacement reviews', () => {
    const { store, task } = setup();
    const artifact = store.saveArtifact(task.id, identity, {
      kind: 'fixture.product',
      content: { value: 3 },
      producer: { kind: 'service', id: 'fixture' },
      evidence_origin: 'synthetic_fixture',
    });
    const ref = {
      id: artifact.id,
      version: artifact.version,
      sha256: artifact.sha256,
    };
    const check = {
      artifact: ref,
      producer_assignment_id: randomUUID(),
      producer_revision: 1,
      verdict: 'needs_review' as const,
      limitations: ['Fixture critique.'],
    };
    store.recordReviewChecks(task.id, [check]);
    const first = store.readTraceBatch().at(-1)!;
    store.recordReviewChecks(task.id, [check]);
    expect(store.readTraceBatch().at(-1)?.event_id).toBe(first.event_id);
    store.recordReviewChecks(task.id, [
      { ...check, verdict: 'supported', limitations: [] },
    ]);
    expect(store.readTraceBatch().at(-1)).toMatchObject({
      action: 'artifact_reviewed',
      evidence_verdict: 'supported',
      supersedes: { event_ids: [first.event_id], artifacts: [ref] },
      reviews: [{ artifact: ref, verdict: 'supported' }],
    });
    expect(first.actor).toBe('Runtime');
    expect(first.summary).toContain('Review availability');
    expect(store.readTraceBatch().at(-1)?.execution_accepted).toBeUndefined();
  });

  it('links revised outputs and replacement reviews within the exact producer history', () => {
    const { store, task } = setup();
    const assignment = store.createAssignments(
      task.id,
      task.current_run_id,
      1,
      [definition()],
    )[0]!;
    const lease = store.acquireAssignment(task.id, assignment.id)!;
    const firstArtifact = store.saveArtifact(task.id, identity, {
      kind: 'fixture.product',
      content: { value: 3 },
      producer: { kind: 'assignment', id: assignment.id },
      generation: lease.generation,
    });
    const firstRef = {
      id: firstArtifact.id,
      version: firstArtifact.version,
      sha256: firstArtifact.sha256,
    };
    const firstSaved = store.readTraceBatch().at(-1)!;
    store.recordReviewChecks(task.id, [
      {
        artifact: firstRef,
        producer_assignment_id: assignment.id,
        producer_revision: 1,
        verdict: 'needs_review',
        limitations: ['Revise the evidence.'],
      },
    ]);
    const firstReview = store.readTraceBatch().at(-1)!;
    store.completeAssignment(task.id, assignment.id, lease.generation, {
      status: 'completed',
      outputs: [firstRef],
      support: 'partial',
      usability: 'needs_review',
    });
    const current = store.read(task.id, identity);
    const decision: ManagerDecision = {
      id: randomUUID(),
      run_id: current.current_run_id,
      generation: current.generation,
      objective_revision: current.objective_revision,
      plan_revision: current.manager!.plan_revision,
      event_cursor: store.traceCursor(),
      explanation: 'Address the saved critique.',
      references: [firstRef],
      action: { type: 'wait', reason: 'Fixture revision.' },
    };
    store.applyManagerDecision(task.id, decision, () => {
      store.applyManagerPlan(task.id, decision, {
        revise: [{ id: assignment.id, brief: 'Resolve the saved critique.' }],
      });
      return {};
    });
    const nextLease = store.acquireAssignment(task.id, assignment.id)!;
    const revised = store.saveArtifact(task.id, identity, {
      kind: 'fixture.product',
      content: { value: 4 },
      producer: { kind: 'assignment', id: assignment.id },
      generation: nextLease.generation,
    });
    const revisedRef = {
      id: revised.id,
      version: revised.version,
      sha256: revised.sha256,
    };
    expect(store.readTraceBatch().at(-1)?.supersedes).toEqual({
      event_ids: [firstSaved.event_id],
      artifacts: [firstRef],
    });
    store.recordReviewChecks(task.id, [
      {
        artifact: revisedRef,
        producer_assignment_id: assignment.id,
        producer_revision: 2,
        verdict: 'supported',
        limitations: [],
      },
    ]);
    expect(store.readTraceBatch().at(-1)?.supersedes).toEqual({
      event_ids: [firstReview.event_id],
      artifacts: [firstRef],
    });
    store.saveArtifact(task.id, identity, {
      kind: 'fixture.product',
      content: { value: 5 },
      producer: { kind: 'service', id: 'other-producer' },
    });
    expect(store.readTraceBatch().at(-1)?.supersedes).toBeUndefined();
  });

  it('attributes an excluded old receipt to the original run after Continue', () => {
    const { store, task } = setup();
    const assignment = store.createAssignments(
      task.id,
      task.current_run_id,
      1,
      [definition()],
    )[0]!;
    store.acquireAssignment(task.id, assignment.id);
    const attempt = store.chargeAttempt(task.id, assignment.id, 'model');
    let current = store.read(task.id, identity);
    store.control(task.id, identity, randomUUID(), {
      schema_version: 'haze.task.control.v3',
      expected_run_id: current.current_run_id,
      expected_generation: current.generation,
      expected_objective_revision: current.objective_revision,
      expected_state_revision: current.state_revision,
      action: 'pause',
    });
    current = store.read(task.id, identity);
    store.control(task.id, identity, randomUUID(), {
      schema_version: 'haze.task.control.v3',
      expected_run_id: current.current_run_id,
      expected_generation: current.generation,
      expected_objective_revision: current.objective_revision,
      expected_state_revision: current.state_revision,
      action: 'continue',
    });
    const nextRun = store.read(task.id, identity).current_run_id;
    expect(nextRun).not.toBe(task.current_run_id);
    store.completeAttempt(task.id, attempt.id, { output: { late: true } });
    expect(
      store.listTraceRecords(task.id, task.current_run_id, identity).at(-1),
    ).toMatchObject({
      run_id: task.current_run_id,
      action: 'late_receipt_recorded',
      execution_accepted: false,
      assignment_revision: 1,
    });
    expect(
      store
        .listTraceRecords(task.id, nextRun, identity)
        .some((trace) => trace.causes.attempt_id === attempt.id),
    ).toBe(false);
  });
});
