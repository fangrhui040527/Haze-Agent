import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  taskRequestSchema,
  type TaskIdentity,
  type TaskRecord,
  type TaskResult,
} from '../../app/contracts/tasks.js';
import {
  type ArtifactImport,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import {
  type TaskControl,
  type TaskUpdate,
} from '../../app/contracts/controls.js';
import {
  TaskStore,
  STORAGE_MARKER,
  type AssignmentDefinition,
} from '../../app/tasks/store.js';

const identity: TaskIdentity = {
  principal: 'test-user',
  workspace: 'test-workspace',
};
const roots: string[] = [],
  stores: TaskStore[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0).reverse())
    if (store.db.isOpen) store.close();
  for (const directory of roots.splice(0)) {
    const target = resolve(directory),
      rel = relative(resolve(tmpdir()), target);
    if (!rel || rel.startsWith('..') || resolve(tmpdir()) === target)
      throw new Error('Unsafe test cleanup target.');
    rmSync(target, { recursive: true, force: true });
  }
});
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'haze-general-store-'));
  roots.push(root);
  return root;
}
function create(root = directory(), recover = true) {
  const store = new TaskStore(root, { recover });
  stores.push(store);
  return store;
}
function request() {
  return taskRequestSchema.parse({
    schema_version: 'haze.task.request.v3',
    objective: 'Explain the uploaded research notes.',
  });
}
function admit(
  store: TaskStore,
  key: string = randomUUID(),
  tools: string[] = [],
) {
  return store.admit(request(), identity, key, { mode: 'fixture', tools }).task;
}
function definition(
  overrides: Partial<AssignmentDefinition> = {},
): AssignmentDefinition {
  return {
    role: 'HazeOps',
    definition_id: 'test.explain',
    capability: 'test',
    definition_version: '3',
    brief: 'Explain the notes.',
    ...overrides,
  };
}
function assignments(
  store: TaskStore,
  task: TaskRecord,
  defs: AssignmentDefinition[],
) {
  return store.createAssignments(
    task.id,
    task.current_run_id,
    task.objective_revision,
    defs,
  );
}
function expected(task: TaskRecord) {
  return {
    expected_objective_revision: task.objective_revision,
    expected_run_id: task.current_run_id,
    expected_generation: task.generation,
    expected_state_revision: task.state_revision,
  };
}
function control(
  store: TaskStore,
  id: string,
  action: TaskControl['action'],
  key: string = randomUUID(),
) {
  const mutation: TaskControl = {
    schema_version: 'haze.task.control.v3',
    ...expected(store.read(id, identity)),
    action,
  };
  return { receipt: store.control(id, identity, key, mutation), mutation, key };
}
function source(
  text: string,
  media_type: ArtifactImport['media_type'] = 'text/plain',
): ArtifactImport {
  return {
    schema_version: 'haze.artifact.import.v3',
    filename: 'notes.txt',
    media_type,
    content_base64: Buffer.from(text).toString('base64'),
  };
}
const ref = (artifact: ArtifactRef): ArtifactRef => ({
  id: artifact.id,
  version: artifact.version,
  sha256: artifact.sha256,
});
function result(products: ArtifactRef[] = []): TaskResult {
  return {
    schema_version: 'haze.task.result.v3',
    answer: 'Supported summary.',
    completion: 'full',
    work_products: products,
    sources: [],
    covered_scope: {},
    uncertainty: [],
    review: {
      status: 'not_required',
      scope: 'Direct source synthesis.',
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
  };
}

describe('general contract and authoritative SQLite store', () => {
  it('requires only v3 objective and refuses incompatible directories without modification', () => {
    expect(request().scope).toBeUndefined();
    expect(() =>
      taskRequestSchema.parse({
        schema_version: 'haze.task.request.v2',
        objective: 'Explain.',
      }),
    ).toThrow();
    const root = directory(),
      old = Buffer.from('historical SQLite bytes');
    writeFileSync(join(root, 'tasks.sqlite'), old);
    expect(() => new TaskStore(root)).toThrow(
      'historical directory was left untouched',
    );
    expect(readdirSync(root)).toEqual(['tasks.sqlite']);
    expect(readFileSync(join(root, 'tasks.sqlite'))).toEqual(old);
    const marked = directory();
    writeFileSync(join(marked, STORAGE_MARKER), '{"format":"old"}');
    expect(() => new TaskStore(marked)).toThrow('Incompatible storage format');
    expect(readdirSync(marked)).toEqual([STORAGE_MARKER]);
  });
  it('deduplicates exact mutation receipts and detects conflicting reuse', () => {
    const store = create(),
      task = admit(store, 'create-once');
    const first = control(store, task.id, 'pause', 'pause-once');
    control(store, task.id, 'resume');
    expect(store.control(task.id, identity, first.key, first.mutation)).toEqual(
      first.receipt,
    );
    expect(store.admit(request(), identity, 'create-once').reused).toBe(true);
    expect(() =>
      store.admit(
        { ...request(), objective: 'Changed objective' },
        identity,
        'create-once',
      ),
    ).toThrow('different content');
    expect(() =>
      store.control(task.id, identity, 'racing-control', {
        ...first.mutation,
        action: 'cancel',
      }),
    ).toThrow('state revision changed');
    expect(store.read(task.id, identity).status).toBe('queued');
  });
  it('accepts exactly 1 MiB decoded UTF-8, keeps byte and content hashes distinct, and authorizes sources before tasks', () => {
    const store = create();
    // NUL requires six JSON bytes per decoded byte; internal persistence must still round-trip it.
    const content = '\0'.repeat(1_048_576),
      imported = store.importArtifact(
        source(content),
        identity,
        'full-size',
      ).artifact;
    expect(store.artifact(imported.id, identity).content).toBe(content);
    expect(imported.original_byte_sha256).toBe(
      createHash('sha256').update(Buffer.from(content)).digest('hex'),
    );
    expect(imported.sha256).not.toBe(imported.original_byte_sha256);
    expect(() =>
      store.artifact(imported.id, { ...identity, principal: 'other-user' }),
    ).toThrow('not found');
    expect(() =>
      store.importArtifact(source('x'.repeat(1_048_577)), identity, 'too-big'),
    ).toThrow();
    expect(() =>
      store.importArtifact(
        { ...source('x'), content_base64: '/w==' },
        identity,
        'invalid-utf8',
      ),
    ).toThrow('valid UTF-8');
    const jsonA = store.importArtifact(
      source('{"b":2,"a":1}', 'application/json'),
      identity,
      'json-a',
    ).artifact;
    const jsonB = store.importArtifact(
      source('{ "a": 1, "b": 2 }', 'application/json'),
      identity,
      'json-b',
    ).artifact;
    expect(jsonA.sha256).toBe(jsonB.sha256);
    expect(jsonA.original_byte_sha256).not.toBe(jsonB.original_byte_sha256);
  });
  it('atomically validates the graph and shares two specialist reservations across connections', () => {
    const root = directory(),
      left = create(root),
      right = create(root, false),
      task = admit(left);
    const one = randomUUID(),
      two = randomUUID();
    expect(() =>
      assignments(left, task, [
        definition({ id: one, dependencies: [two] }),
        definition({ id: two, dependencies: [one] }),
      ]),
    ).toThrow('acyclic');
    expect(left.read(task.id, identity).usage.assignments).toBe(0);
    const jobs = assignments(left, task, [
      definition(),
      definition(),
      definition(),
    ]);
    expect(left.acquireAssignment(task.id, jobs[0]!.id)).not.toBeNull();
    expect(right.acquireAssignment(task.id, jobs[1]!.id)).not.toBeNull();
    expect(left.acquireAssignment(task.id, jobs[2]!.id)).toBeNull();
    left.completeAssignment(task.id, jobs[0]!.id, task.generation, {
      status: 'waiting',
    });
    expect(right.acquireAssignment(task.id, jobs[2]!.id)).not.toBeNull();
    const a = left.saveArtifact(task.id, identity, {
      kind: 'test.result',
      producer: { kind: 'assignment', id: jobs[1]!.id },
      content: { value: 1 },
    });
    const b = right.saveArtifact(task.id, identity, {
      kind: 'test.result',
      producer: { kind: 'assignment', id: jobs[2]!.id },
      content: { value: 2 },
    });
    expect(left.read(task.id, identity).usage.artifacts).toBe(2);
    expect(left.artifact(a.id, identity).content).toEqual({ value: 1 });
    expect(right.artifact(b.id, identity).content).toEqual({ value: 2 });
  });
  it('reserves model turns for synthesis and independent review, charging failures without retries', () => {
    const store = create(),
      task = admit(store),
      jobs = assignments(store, task, [
        definition({ definition_id: 'evidence-synthesis.extract' }),
        definition({
          role: 'Manager',
          definition_id: 'core.manager.synthesis',
        }),
        definition({ role: 'EvidenceCritic' }),
      ]);
    store.acquireAssignment(task.id, jobs[0]!.id);
    for (let index = 0; index < 4; index++) {
      const attempt = store.chargeAttempt(task.id, jobs[0]!.id, 'model');
      store.completeAttempt(task.id, attempt.id, {
        error: { code: 'provider_failure' },
      });
    }
    expect(() => store.chargeAttempt(task.id, jobs[0]!.id, 'model')).toThrow(
      'reserved',
    );
    store.acquireAssignment(task.id, jobs[2]!.id);
    store.chargeAttempt(task.id, jobs[2]!.id, 'model');
    expect(() => store.chargeAttempt(task.id, jobs[2]!.id, 'model')).toThrow(
      'reserved',
    );
    store.acquireAssignment(task.id, jobs[1]!.id);
    store.chargeAttempt(task.id, jobs[1]!.id, 'model');
    expect(store.read(task.id, identity).usage.model_calls).toBe(6);
    expect(store.attempts(task.id, identity)).toHaveLength(6);
  });
  it('persists validated actions before dispatch and dispatches each action only once', () => {
    const store = create(),
      task = admit(store),
      job = assignments(store, task, [definition()])[0]!;
    store.acquireAssignment(task.id, job.id);
    expect(() => store.dispatchAction(task.id, job.id, 'action-1')).toThrow(
      'Persist validated',
    );
    store.recordAction(
      task.id,
      job.id,
      'action-1',
      { model_response: 'saved' },
      { type: 'finish' },
    );
    expect(store.dispatchAction(task.id, job.id, 'action-1')).toBe(true);
    expect(store.dispatchAction(task.id, job.id, 'action-1')).toBe(false);
    expect(() =>
      store.recordAction(task.id, job.id, 'action-1', {}, { type: 'tool' }),
    ).toThrow('reused');
  });
  it('invalidates dependent branches, excludes late output, and reuses immutable sources only after explicit checks', () => {
    const store = create(),
      imported = store.importArtifact(
        source('Original source.'),
        identity,
        'source',
      ).artifact;
    const task = store.admit(
      { ...request(), context_refs: [ref(imported)] },
      identity,
      'task',
      { mode: 'fixture', tools: ['test.lookup'] },
    ).task;
    const a = randomUUID(),
      jobs = assignments(store, task, [
        definition({ id: a, inputs: [ref(imported)], tools: ['test.lookup'] }),
        definition({ role: 'EvidenceCritic', dependencies: [a] }),
      ]);
    const lease = store.acquireAssignment(task.id, jobs[0]!.id)!;
    const artifact = store.saveArtifact(task.id, identity, {
      kind: 'test.analysis',
      content: { answer: 'Before correction.' },
      producer: { kind: 'assignment', id: lease.id },
      dependencies: [ref(imported)],
      generation: lease.generation,
    });
    const attempt = store.chargeAttempt(task.id, lease.id, 'tool', {
      tool: 'test.lookup',
    });
    const update: TaskUpdate = {
      schema_version: 'haze.task.update.v3',
      ...expected(store.read(task.id, identity)),
      kind: 'correction',
      passage: 'Use the narrower window exactly as written.',
      affected_assignment_ids: [lease.id],
      scope: { window: 'narrow' },
    };
    store.update(task.id, identity, 'correction', update);
    const revised = store.read(task.id, identity);
    expect(revised.objective_revision).toBe(2);
    expect(revised.corrections[0]!.passage).toBe(update.passage);
    expect(
      revised.assignments.map((assignment) => assignment.revision),
    ).toEqual([2, 2]);
    expect(
      store.completeAttempt(task.id, attempt.id, { output: { late: true } })
        .accepted,
    ).toBe(false);
    expect(() =>
      store.saveArtifact(task.id, identity, {
        kind: 'test.late',
        content: {},
        producer: { kind: 'assignment', id: lease.id },
        generation: lease.generation,
      }),
    ).toThrow('fenced');
    expect(store.artifact(artifact.id, identity).sha256).toBe(artifact.sha256);
    expect(revised.status).toBe('paused');
    control(store, task.id, 'resume');
    expect(() => store.acquireAssignment(task.id, lease.id)).toThrow(
      'applicability',
    );
    store.recordApplicability(
      task.id,
      identity,
      ref(imported),
      true,
      'Exact source remains applicable after explicit check.',
      'Manager',
    );
    expect(
      store.acquireAssignment(task.id, lease.id)?.acknowledged_revision,
    ).toBe(2);
  });
  it('preserves charged unknown outcomes and the deadline on restart/resume, then admits a linked continuation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    const root = directory(),
      first = create(root),
      task = admit(first),
      job = assignments(first, task, [definition()])[0]!;
    first.acquireAssignment(task.id, job.id);
    const attempt = first.chargeAttempt(task.id, job.id, 'model');
    first.close();
    const restarted = create(root),
      recovered = restarted.read(task.id, identity);
    expect(recovered.status).toBe('paused');
    expect(recovered.usage.model_calls).toBe(1);
    expect(recovered.limits.deadline).toBe(task.limits.deadline);
    expect(restarted.attempts(task.id, identity)[0]!.status).toBe('unknown');
    control(restarted, task.id, 'resume');
    expect(restarted.read(task.id, identity).usage.model_calls).toBe(1);
    expect(
      restarted.completeAttempt(task.id, attempt.id, { output: { late: true } })
        .accepted,
    ).toBe(false);
    control(restarted, task.id, 'pause');
    vi.setSystemTime(new Date(Date.parse(task.limits.deadline) + 1));
    expect(() => control(restarted, task.id, 'resume')).toThrow(
      'expired deadline',
    );
    control(restarted, task.id, 'continue');
    const continued = restarted.read(task.id, identity);
    expect(continued.current_run_id).not.toBe(task.current_run_id);
    expect(continued.runs[1]!.predecessor_run_id).toBe(task.current_run_id);
    expect(continued.usage.model_calls).toBe(0);
    expect(continued.runs[0]!.usage.model_calls).toBe(1);
  });
  it('keeps one bounded peer channel, deduplicates messages and releases waiting slots', () => {
    const store = create(),
      task = admit(store),
      jobs = assignments(store, task, [
        definition(),
        definition({ role: 'EvidenceCritic' }),
        definition({ role: 'Manager' }),
      ]);
    for (const job of jobs) store.acquireAssignment(task.id, job.id);
    const channel = store.openPeerChannel(
      task.id,
      task.current_run_id,
      'Independently check exact analysis.',
      jobs.slice(0, 2).map((job) => job.id),
    );
    const first = store.sendPeerMessage(
      task.id,
      channel.id,
      jobs[0]!.id,
      jobs[1]!.id,
      'Review exact artifact.',
      'request',
    );
    expect(
      store.sendPeerMessage(
        task.id,
        channel.id,
        jobs[0]!.id,
        jobs[1]!.id,
        'Review exact artifact.',
        'request',
      ),
    ).toEqual(first);
    expect(() =>
      store.sendPeerMessage(
        task.id,
        channel.id,
        jobs[0]!.id,
        jobs[1]!.id,
        'Changed.',
        'request',
      ),
    ).toThrow('different content');
    store.completeAssignment(task.id, jobs[0]!.id, task.generation, {
      status: 'waiting',
    });
    store.completeAssignment(task.id, jobs[2]!.id, task.generation, {
      status: 'completed',
    });
    expect(store.peerChannelForRun(task.current_run_id)?.status).toBe('open');
    store.sendPeerMessage(
      task.id,
      channel.id,
      jobs[1]!.id,
      jobs[0]!.id,
      'Independent result agrees.',
      'reply',
    );
    store.completeAssignment(task.id, jobs[1]!.id, task.generation, {
      status: 'completed',
      support: 'supported',
    });
    expect(store.peerChannelForRun(task.current_run_id)?.status).toBe('closed');
    expect(
      store.peerMessages(task.id, identity, channel.id, jobs[0]!.id),
    ).toHaveLength(1);
    store.wakeAssignment(task.id, jobs[0]!.id);
    expect(store.acquireAssignment(task.id, jobs[0]!.id)).not.toBeNull();
    expect(() =>
      store.openPeerChannel(
        task.id,
        task.current_run_id,
        'Second purpose',
        jobs.slice(0, 2).map((job) => job.id),
      ),
    ).toThrow('Only one');
  });
  it('persists human/data waits and accepts exact new sources in the clarification', () => {
    const store = create(),
      task = admit(store),
      job = assignments(store, task, [definition()])[0]!;
    store.acquireAssignment(task.id, job.id);
    const question = store.askQuestion(
      task.id,
      job.id,
      'Please upload the source.',
      'data',
    );
    expect(store.read(task.id, identity).status).toBe('waiting');
    expect(() => control(store, task.id, 'resume')).toThrow('Answer persisted');
    const imported = store.importArtifact(
      source('New source.'),
      identity,
      'new-source',
    ).artifact;
    store.update(task.id, identity, 'answer', {
      schema_version: 'haze.task.update.v3',
      ...expected(store.read(task.id, identity)),
      kind: 'clarification',
      passage: 'The attached note answers the question.',
      question_id: question.id,
      context_refs: [ref(imported)],
    });
    const updated = store.read(task.id, identity);
    expect(updated.questions[0]!.status).toBe('answered');
    expect(updated.corrections[0]!.context_refs).toEqual([ref(imported)]);
    expect(() => store.acquireAssignment(task.id, job.id)).toThrow(
      'applicability',
    );
    store.recordApplicability(
      task.id,
      identity,
      ref(imported),
      true,
      'The supplied source was explicitly inspected against the clarification.',
      'Manager:test',
    );
    expect(store.acquireAssignment(task.id, job.id)?.inputs).toEqual([
      ref(imported),
    ]);
  });
  it('checks current grants for tool admission and derived artifact disclosure after revocation', () => {
    const store = create(),
      task = admit(store, 'task', ['test.lookup']),
      jobs = assignments(store, task, [
        definition({ tools: ['test.lookup'] }),
        definition({ role: 'Manager' }),
      ]);
    store.acquireAssignment(task.id, jobs[0]!.id);
    store.acquireAssignment(task.id, jobs[1]!.id);
    const captured = store.saveArtifact(task.id, identity, {
      kind: 'test.capture',
      content: 'Protected evidence.',
      producer: { kind: 'assignment', id: jobs[0]!.id },
    });
    const derived = store.saveArtifact(task.id, identity, {
      kind: 'test.derived',
      content: 'Derived answer.',
      producer: { kind: 'assignment', id: jobs[1]!.id },
      dependencies: [ref(captured)],
    });
    control(store, task.id, 'revoke');
    expect(() => store.artifact(captured.id, identity)).toThrow(
      'revoked tool grant',
    );
    expect(() => store.artifact(derived.id, identity)).toThrow(
      'revoked tool grant',
    );
    control(store, task.id, 'resume');
    store.acquireAssignment(task.id, jobs[0]!.id);
    expect(() =>
      store.chargeAttempt(task.id, jobs[0]!.id, 'tool', {
        tool: 'test.lookup',
      }),
    ).toThrow('revoked');
  });
  it('keeps stale artifacts out of published results and forbids producer self-review', () => {
    const store = create(),
      task = admit(store),
      jobs = assignments(store, task, [
        definition(),
        definition({ role: 'EvidenceCritic' }),
      ]);
    store.acquireAssignment(task.id, jobs[0]!.id);
    store.acquireAssignment(task.id, jobs[1]!.id);
    const product = store.saveArtifact(task.id, identity, {
      kind: 'test.product',
      content: {},
      producer: { kind: 'assignment', id: jobs[0]!.id },
    });
    store.recordApplicability(
      task.id,
      identity,
      product,
      false,
      'Rejected evidence.',
      'EvidenceCritic',
    );
    expect(() =>
      store.saveResult(
        task.id,
        task.current_run_id,
        task.generation,
        result([ref(product)]),
      ),
    ).toThrow('inapplicable');
    const review = store.saveArtifact(task.id, identity, {
      kind: 'test.review',
      content: {},
      producer: { kind: 'assignment', id: jobs[1]!.id },
    });
    store.completeAssignment(task.id, jobs[1]!.id, task.generation, {
      status: 'completed',
      support: 'supported',
    });
    expect(() =>
      store.saveResult(task.id, task.current_run_id, task.generation, {
        ...result([ref(review)]),
        review: {
          status: 'supported',
          scope: 'Self review attempt.',
          limitations: [],
          reviewer_assignment_id: jobs[1]!.id,
        },
      }),
    ).toThrow('own output');
  });
  it('fences stale failures and resumes unstarted work after restart without replenishing attempts', () => {
    const root = directory(),
      first = create(root),
      task = admit(first);
    const jobs = assignments(first, task, [definition(), definition()]);
    first.acquireAssignment(task.id, jobs[0]!.id);
    const attempt = first.chargeAttempt(task.id, jobs[0]!.id, 'model');
    first.completeAttempt(task.id, attempt.id, { output: { accepted: true } });
    first.completeAssignment(task.id, jobs[0]!.id, task.generation, {
      status: 'completed',
      usability: 'usable',
    });
    first.acquireAssignment(task.id, jobs[1]!.id);
    first.close();
    const restarted = create(root),
      recovered = restarted.read(task.id, identity);
    expect(recovered.status).toBe('queued');
    expect(recovered.assignments.map((job) => job.status)).toEqual([
      'completed',
      'queued',
    ]);
    expect(recovered.usage.model_calls).toBe(1);
    restarted.stop(
      task.id,
      'failed',
      'old_worker_failure',
      'Late old worker failure.',
      {
        run_id: task.current_run_id,
        generation: task.generation,
        objective_revision: task.objective_revision,
      },
    );
    expect(restarted.read(task.id, identity).status).toBe('queued');
    expect(restarted.acquireAssignment(task.id, jobs[1]!.id)).not.toBeNull();
  });
  it('retains revision-scoped peer history while enforcing one run-wide six-message reservation', () => {
    const store = create(),
      task = admit(store),
      jobs = assignments(store, task, [
        definition(),
        definition({ role: 'EvidenceCritic' }),
      ]);
    const ids = jobs.map((job) => job.id);
    for (const id of ids) store.acquireAssignment(task.id, id);
    const initial = store.openPeerChannel(
      task.id,
      task.current_run_id,
      'Check analysis.',
      ids,
    );
    for (let index = 0; index < 3; index++)
      store.sendPeerMessage(
        task.id,
        initial.id,
        ids[0]!,
        ids[1]!,
        `Original message ${index}`,
        `original-${index}`,
      );
    store.update(task.id, identity, 'correction', {
      schema_version: 'haze.task.update.v3',
      ...expected(store.read(task.id, identity)),
      kind: 'correction',
      passage: 'Use revised scope.',
    });
    expect(store.peerChannelForRun(task.current_run_id)).toBeUndefined();
    for (const id of ids) store.acquireAssignment(task.id, id);
    const revised = store.openPeerChannel(
      task.id,
      task.current_run_id,
      'Recheck revised analysis.',
      ids,
    );
    expect(revised.id).toBe(initial.id);
    expect(revised.revision).toBe(2);
    expect(revised.messages).toBe(3);
    expect(revised.expires_at).toBe(initial.expires_at);
    expect(store.peerMessages(task.id, identity, revised.id, ids[1]!)).toEqual(
      [],
    );
    for (let index = 0; index < 3; index++)
      store.sendPeerMessage(
        task.id,
        revised.id,
        ids[0]!,
        ids[1]!,
        `Revised message ${index}`,
        `revised-${index}`,
      );
    expect(store.peerChannelForRun(task.current_run_id)?.status).toBe('closed');
    expect(
      store.peerMessages(task.id, identity, revised.id, ids[1]!),
    ).toHaveLength(3);
    expect(
      store.db
        .prepare('SELECT body FROM channel_history WHERE run_id=?')
        .all(task.current_run_id),
    ).toHaveLength(1);
    store.update(task.id, identity, 'third-correction', {
      schema_version: 'haze.task.update.v3',
      ...expected(store.read(task.id, identity)),
      kind: 'correction',
      passage: 'Third scope.',
    });
    expect(() =>
      store.openPeerChannel(
        task.id,
        task.current_run_id,
        'No budget refill.',
        ids,
      ),
    ).toThrow('cannot replenish');
  });
  it('enforces peer UTF-8 byte ceilings and expiry without charging rejected messages', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    const store = create(),
      task = admit(store),
      jobs = assignments(store, task, [
        definition(),
        definition({ role: 'EvidenceCritic' }),
      ]);
    for (const job of jobs) store.acquireAssignment(task.id, job.id);
    const channel = store.openPeerChannel(
      task.id,
      task.current_run_id,
      'Bounded exchange.',
      jobs.map((job) => job.id),
    );
    expect(() =>
      store.sendPeerMessage(
        task.id,
        channel.id,
        jobs[0]!.id,
        jobs[1]!.id,
        '界'.repeat(4097),
        'too-large',
      ),
    ).toThrow('byte budget');
    expect(store.peerChannelForRun(task.current_run_id)?.messages).toBe(0);
    vi.setSystemTime(new Date(Date.parse(channel.expires_at)));
    expect(() =>
      store.sendPeerMessage(
        task.id,
        channel.id,
        jobs[0]!.id,
        jobs[1]!.id,
        'Expired.',
        'expired',
      ),
    ).toThrow();
    expect(store.peerChannelForRun(task.current_run_id)?.messages).toBe(0);
  });
  it('does not count cancelled predecessor runs against fresh continuation capacity', () => {
    const store = create(),
      a = admit(store, 'a');
    admit(store, 'b');
    control(store, a.id, 'pause');
    const c = admit(store, 'c');
    expect(() => control(store, a.id, 'continue')).toThrow('Two active tasks');
    control(store, c.id, 'cancel');
    control(store, a.id, 'continue');
    const continued = store.read(a.id, identity);
    expect(continued.status).toBe('queued');
    expect(continued.runs[0]!.status).toBe('cancelled');
    expect(continued.runs[1]!.usage.model_calls).toBe(0);
  });
  it('pins exact agent/capability versions and refuses changed instructions before execution', () => {
    const store = create(),
      task = admit(store);
    const configured = {
      agents: { HazeOps: 'agent-v3' },
      capabilities: { test: 'cap-v3' },
      tools: [],
      assignments: {
        'test.explain': {
          version: '3',
          capability: 'test',
          role: 'HazeOps',
          tools: [],
        },
      },
    };
    store.configureDefinitions(configured);
    const job = assignments(store, task, [definition()])[0]!;
    expect(job.agent_version).toBe('agent-v3');
    expect(job.capability_version).toBe('cap-v3');
    store.configureDefinitions({
      ...configured,
      agents: { HazeOps: 'agent-v4' },
    });
    expect(() => store.acquireAssignment(task.id, job.id)).toThrow(
      'Pinned agent',
    );
    expect(store.read(task.id, identity).usage.model_calls).toBe(0);
  });
  it('adopts only undispatched persisted actions after restart and rejects old caller leases before charging', () => {
    const root = directory(),
      first = create(root),
      task = admit(first),
      job = assignments(first, task, [definition()])[0]!;
    const oldLease = first.acquireAssignment(task.id, job.id)!;
    first.recordAction(
      task.id,
      job.id,
      'persisted',
      { text: 'Validated response.' },
      { type: 'save' },
    );
    first.close();
    const restarted = create(root),
      lease = restarted.acquireAssignment(task.id, job.id)!;
    expect(() =>
      restarted.chargeAttempt(
        task.id,
        job.id,
        'model',
        {},
        {
          generation: oldLease.generation,
          assignment_revision: oldLease.revision,
          lease_token: oldLease.lease_token!,
        },
      ),
    ).toThrow('current assignment lease');
    expect(restarted.read(task.id, identity).usage.model_calls).toBe(0);
    const adopted = restarted.adoptAction(task.id, job.id, 'persisted');
    expect(adopted.created_generation).toBe(oldLease.generation);
    expect(adopted.generation).toBe(lease.generation);
    expect(adopted.response).toEqual({ text: 'Validated response.' });
    expect(restarted.dispatchAction(task.id, job.id, 'persisted')).toBe(true);
    expect(() => restarted.adoptAction(task.id, job.id, 'persisted')).toThrow(
      'undispatched',
    );
    expect(restarted.actions(task.id, identity)).toHaveLength(1);
  });
  it('pauses unknown remote outcomes without replenishing budget/deadline and requires an explicit replacement', () => {
    const store = create(),
      task = admit(store),
      job = assignments(store, task, [definition()])[0]!;
    const originalLease = store.acquireAssignment(task.id, job.id)!;
    const expectedLease = {
      generation: originalLease.generation,
      assignment_revision: originalLease.revision,
      lease_token: originalLease.lease_token!,
    };
    const unknown = store.chargeAttempt(
      task.id,
      job.id,
      'model',
      {},
      expectedLease,
    );
    store.interruptUnknown(
      task.id,
      unknown.id,
      { outcome: 'unknown', message: 'Connection closed before a receipt.' },
      expectedLease,
    );
    const paused = store.read(task.id, identity);
    expect(paused.status).toBe('paused');
    expect(paused.generation).toBe(task.generation + 1);
    expect(paused.usage.model_calls).toBe(1);
    expect(paused.limits.deadline).toBe(task.limits.deadline);
    expect(paused.assignments[0]!.status).toBe('paused');
    expect(paused.assignments[0]!.lease_token).toBeUndefined();
    expect(store.attempts(task.id, identity)[0]!.status).toBe('unknown');
    expect(() => store.acquireAssignment(task.id, job.id)).toThrow('paused');
    control(store, task.id, 'resume');
    const replacementLease = store.acquireAssignment(task.id, job.id)!;
    const replacement = store.chargeAttempt(
      task.id,
      job.id,
      'model',
      {},
      {
        generation: replacementLease.generation,
        assignment_revision: replacementLease.revision,
        lease_token: replacementLease.lease_token!,
      },
    );
    expect(store.read(task.id, identity).usage.model_calls).toBe(2);
    expect(store.read(task.id, identity).limits.deadline).toBe(
      task.limits.deadline,
    );
    // A delayed error from the original attempt cannot pause the newly leased replacement.
    store.interruptUnknown(
      task.id,
      unknown.id,
      { outcome: 'unknown', message: 'Delayed old callback.' },
      expectedLease,
    );
    expect(store.read(task.id, identity).status).toBe('running');
    const late = store.completeAttempt(task.id, unknown.id, {
      output: 'Late original result.',
      receipt: { response_id: 'old' },
    });
    expect(late.accepted).toBe(false);
    expect(late.output).toBe('Late original result.');
    expect(
      store.completeAttempt(task.id, replacement.id, {
        output: 'Accepted replacement.',
      }).accepted,
    ).toBe(true);
    // A receipt already committed for the replacement wins a simultaneous timeout callback.
    store.interruptUnknown(task.id, replacement.id, { outcome: 'unknown' });
    expect(store.read(task.id, identity).status).toBe('running');
    expect(
      store.attempts(task.id, identity).map((attempt) => attempt.status),
    ).toEqual(['completed', 'completed']);
  });
  it('releases every shared slot during a human wait and allows revocation after completion', () => {
    const store = create(),
      waiting = admit(store, 'waiting'),
      jobs = assignments(store, waiting, [definition(), definition()]);
    for (const job of jobs) store.acquireAssignment(waiting.id, job.id);
    store.askQuestion(waiting.id, jobs[0]!.id, 'What source should be used?');
    expect(
      store.read(waiting.id, identity).assignments.map((job) => job.status),
    ).toEqual(['waiting', 'paused']);
    const other = admit(store, 'other', ['test.lookup']),
      otherJobs = assignments(store, other, [
        definition({ tools: ['test.lookup'] }),
        definition({ role: 'EvidenceCritic' }),
      ]);
    for (const job of otherJobs)
      expect(store.acquireAssignment(other.id, job.id)).not.toBeNull();
    const product = store.saveArtifact(other.id, identity, {
      kind: 'test.protected',
      content: 'Protected.',
      producer: { kind: 'assignment', id: otherJobs[0]!.id },
    });
    for (const job of otherJobs)
      store.completeAssignment(other.id, job.id, other.generation, {
        status: 'completed',
      });
    store.saveResult(
      other.id,
      other.current_run_id,
      other.generation,
      result([ref(product)]),
    );
    control(store, other.id, 'revoke');
    expect(store.read(other.id, identity).status).toBe('completed');
    expect(store.read(other.id, identity).result?.currency).toBe('stale');
    expect(() => store.artifact(product.id, identity)).toThrow(
      'revoked tool grant',
    );
  });
});
