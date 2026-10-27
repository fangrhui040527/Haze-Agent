import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactSchema,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import {
  taskRecordSchema,
  taskResultSchema,
  type TaskRecord,
} from '../../app/contracts/tasks.js';
import type {
  ReductionProgrammeAttempt,
  ReductionProgrammeRevision,
  ReductionProgrammeSnapshot,
} from '../../app/contracts/damage-reduction-programme.js';
import { contractHash } from '../../app/contracts/json.js';
import { ReductionProgrammeRepository } from '../../app/capabilities/damage-reduction-programmes/repository.js';
import { ReductionProgrammeService } from '../../app/capabilities/damage-reduction-programmes/service.js';
import {
  programmeCapacity,
  programmeInputFingerprint,
  projectReductionProgramme,
} from '../../app/capabilities/damage-reduction-programmes/projection.js';
import { syntheticProgrammeCreateRequest } from '../../app/capabilities/damage-reduction-programmes/fixtures.js';
import type { ProgrammeHost } from '../../app/capabilities/damage-reduction-programmes/ports.js';

const opened: DatabaseSync[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
const identity = { principal: 'owner', workspace: 'local' };
const scope = { ...identity, mode: 'fixture' as const };
const at = '2026-10-27T00:00:00Z';
const sourceContent = { declared: 'exact synthetic source' };
const sourceRef: ArtifactRef = {
  id: randomUUID(),
  version: 1,
  sha256: contractHash(sourceContent),
};
function snapshot(): ReductionProgrammeSnapshot {
  const request = syntheticProgrammeCreateRequest(sourceRef);
  return {
    schema_version: 'haze.reduction.programme.v1',
    id: randomUUID(),
    revision: 1,
    mode: 'fixture',
    title: request.title,
    accountable_owner: request.accountable_owner,
    scientific_owner: null,
    preview: request.preview,
    budget: request.budget,
    created_at: at,
    updated_at: at,
  };
}
function revision(
  value: ReductionProgrammeSnapshot,
  kind: ReductionProgrammeRevision['kind'] = 'create',
): ReductionProgrammeRevision {
  return {
    programme_id: value.id,
    revision: value.revision,
    previous_revision: value.revision - 1,
    kind,
    reason: 'Explicit engineering fixture operation.',
    snapshot: value,
    invalidated_phases: [],
    created_at: at,
  };
}
function attempt(value: ReductionProgrammeSnapshot): ReductionProgrammeAttempt {
  return {
    schema_version: 'haze.reduction.programme.attempt.v1',
    id: randomUUID(),
    programme_id: value.id,
    programme_revision: 1,
    phase: 'assessment',
    task_id: randomUUID(),
    run_id: randomUUID(),
    objective_revision: 1,
    input_fingerprint: programmeInputFingerprint(value, 'assessment'),
    selected_refs: [sourceRef],
    predecessor_attempt_id: null,
    assessment_attempt_id: null,
    reservation: { model_calls: 40, tool_calls: 40 },
    created_at: at,
  };
}
function taskFor(
  link: ReductionProgrammeAttempt,
  status: TaskRecord['status'] = 'running',
  modelCalls = 3,
  toolCalls = 5,
): TaskRecord {
  const limits = {
    deadline: '2026-10-27T00:05:00Z',
    max_model_calls: 40,
    max_tool_calls: 40,
    max_assignments: 16,
    max_artifacts: 64,
    max_model_input_bytes: 24576,
    max_model_output_tokens: 1200,
    reserved_model_calls: 2,
  };
  const usage = {
    model_calls: modelCalls,
    tool_calls: toolCalls,
    assignments: 1,
    artifacts: 1,
  };
  return taskRecordSchema.parse({
    schema_version: 'haze.task.v3',
    id: link.task_id,
    original_request: {
      schema_version: 'haze.task.request.v3',
      objective: 'Assess the supplied residual damage scenario.',
    },
    objective_revision: 1,
    current_run_id: link.run_id,
    generation: 1,
    state_revision: 1,
    identity,
    permissions: { tools: [], effects: [] },
    mode: 'fixture',
    status,
    created_at: at,
    updated_at: at,
    limits,
    usage,
    runs: [
      {
        id: link.run_id,
        task_id: link.task_id,
        objective_revision: 1,
        generation: 1,
        state_revision: 1,
        status,
        limits,
        usage,
        created_at: at,
        updated_at: at,
      },
    ],
    assignments: [],
    corrections: [],
    questions: [],
    artifacts: [],
  });
}
function repository() {
  const db = new DatabaseSync(':memory:');
  opened.push(db);
  return { db, repo: new ReductionProgrammeRepository(db) };
}
function hostFor(task?: TaskRecord): ProgrammeHost {
  const source = artifactSchema.parse({
    schema_version: 'haze.artifact.v3',
    ...sourceRef,
    identity,
    kind: 'source',
    producer: { kind: 'user', id: 'owner' },
    created_at: at,
    dependencies: [],
    content: sourceContent,
  });
  return {
    mode: 'fixture',
    atomic: (fn) => fn(),
    afterCommit: (fn) => fn(),
    readTask: () => {
      if (!task) throw new Error('Task unavailable.');
      return task;
    },
    readArtifact: () => source,
    assertEvidenceCurrent: () => undefined,
    retainSelection: () => sourceRef,
    pinTaskInputs: () => undefined,
    runResult: () => undefined,
    previewView: () => {
      throw new Error('No exact committed result.');
    },
    admitTask: () => {
      throw new Error('No automatic task admission.');
    },
    updateTask: () => {
      throw new Error('No automatic task mutation.');
    },
    controlTask: () => {
      throw new Error('No automatic task control.');
    },
  };
}

describe('programme immutable repository and partitioning', () => {
  it('adds its schema without changing existing task history and reopens idempotently', () => {
    const db = new DatabaseSync(':memory:');
    opened.push(db);
    db.exec(
      "CREATE TABLE existing_tasks(id TEXT PRIMARY KEY,body TEXT); INSERT INTO existing_tasks VALUES('old','retained');",
    );
    new ReductionProgrammeRepository(db);
    new ReductionProgrammeRepository(db);
    expect(db.prepare('SELECT body FROM existing_tasks').get()).toEqual(
      expect.objectContaining({ body: 'retained' }),
    );
  });
  it('partitions programme reads and listings by principal, workspace and mode', () => {
    const { repo } = repository();
    const saved = snapshot();
    repo.create(scope, revision(saved));
    expect(repo.get(scope, saved.id)).toEqual(saved);
    for (const partition of [
      { ...scope, principal: 'other' },
      { ...scope, workspace: 'other' },
      { ...scope, mode: 'live' as const },
    ]) {
      expect(repo.list(partition)).toEqual([]);
      expect(() => repo.get(partition, saved.id)).toThrow(
        expect.objectContaining({ code: 'programme_not_found' }),
      );
    }
  });
  it('requires optimistic concurrency and preserves append-only revision history', () => {
    const { db, repo } = repository();
    const saved = snapshot();
    repo.create(scope, revision(saved));
    const next = { ...saved, revision: 2, title: 'Updated label' };
    repo.append(scope, 1, revision(next, 'metadata'));
    expect(() => repo.append(scope, 1, revision(next, 'metadata'))).toThrow(
      expect.objectContaining({ code: 'programme_revision_conflict' }),
    );
    expect(repo.revisions(scope, saved.id)).toHaveLength(2);
    expect(() =>
      db
        .prepare(
          'UPDATE reduction_programme_revisions SET body=? WHERE programme_id=?',
        )
        .run('{}', saved.id),
    ).toThrow('Programme history is immutable');
    expect(() =>
      db
        .prepare(
          'DELETE FROM reduction_programme_revisions WHERE programme_id=?',
        )
        .run(saved.id),
    ).toThrow('Programme history is immutable');
  });
  it('rolls back revision, attempt reservation and receipt together on the shared connection', () => {
    const { db, repo } = repository();
    const saved = snapshot();
    repo.create(scope, revision(saved));
    const linked = attempt(saved);
    db.exec('BEGIN IMMEDIATE');
    repo.append(scope, 1, revision({ ...saved, revision: 2 }, 'phase'));
    repo.bind(scope, linked);
    repo.saveReceipt(scope, 'phase-op', 'a'.repeat(64), {
      schema_version: 'haze.reduction.programme.receipt.v1',
      programme_id: saved.id,
      revision: 2,
      operation: 'phase',
      attempt: linked,
    });
    db.exec('ROLLBACK');
    expect(repo.get(scope, saved.id).revision).toBe(1);
    expect(repo.attempts(scope, saved.id)).toEqual([]);
    expect(repo.receipt(scope, 'phase-op', 'a'.repeat(64))).toBeUndefined();
  });
  it('retains idempotent operation receipts and rejects key reuse for different inputs', () => {
    const { repo } = repository();
    const saved = snapshot();
    repo.create(scope, revision(saved));
    const result = {
      schema_version: 'haze.reduction.programme.receipt.v1' as const,
      programme_id: saved.id,
      revision: 1,
      operation: 'create' as const,
      attempt: null,
    };
    repo.saveReceipt(scope, 'create-op', 'b'.repeat(64), result);
    expect(repo.receipt(scope, 'create-op', 'b'.repeat(64))).toEqual(result);
    expect(() => repo.receipt(scope, 'create-op', 'c'.repeat(64))).toThrow(
      expect.objectContaining({ code: 'programme_idempotency_conflict' }),
    );
  });
});

describe('programme authoritative resource reconciliation and fingerprints', () => {
  it('holds unused active reservations and releases only unused terminal capacity', () => {
    const saved = snapshot(),
      linked = attempt(saved);
    const task = taskFor(linked);
    expect(programmeCapacity(saved, [linked], () => task)).toMatchObject({
      charged_model_calls: 3,
      charged_tool_calls: 5,
      reserved_model_calls: 37,
      reserved_tool_calls: 35,
      remaining_model_calls: 360,
      remaining_tool_calls: 360,
      remaining_runs: 11,
      remaining_attempts: { assessment: 2, planning: 3 },
      active_attempt_id: linked.id,
    });
    task.runs[0]!.status = 'cancelled';
    expect(programmeCapacity(saved, [linked], () => task)).toMatchObject({
      charged_model_calls: 3,
      charged_tool_calls: 5,
      reserved_model_calls: 0,
      reserved_tool_calls: 0,
      remaining_model_calls: 397,
      remaining_tool_calls: 395,
      active_attempt_id: null,
    });
  });
  it('does not release unknown usage or double-charge duplicate linked run projections', () => {
    const saved = snapshot(),
      linked = attempt(saved);
    expect(
      programmeCapacity(saved, [linked], () => {
        throw new Error('Unknown authoritative run');
      }),
    ).toMatchObject({
      remaining_model_calls: 360,
      reserved_model_calls: 40,
      active_attempt_id: linked.id,
    });
    const task = taskFor(linked, 'failed', 2, 4);
    expect(
      programmeCapacity(
        saved,
        [linked, { ...linked, id: randomUUID() }],
        () => task,
      ),
    ).toMatchObject({
      charged_model_calls: 2,
      charged_tool_calls: 4,
      remaining_model_calls: 398,
      remaining_runs: 11,
    });
  });
  it('excludes unrelated notes/metadata from fingerprints while fencing affected descendants', () => {
    const saved = snapshot();
    const metadata = { ...saved, revision: 2, title: 'Unrelated note label' };
    expect(programmeInputFingerprint(metadata, 'assessment')).toBe(
      programmeInputFingerprint(saved, 'assessment'),
    );
    expect(
      programmeInputFingerprint(metadata, 'planning', 'assessment-a'),
    ).toBe(programmeInputFingerprint(saved, 'planning', 'assessment-a'));
    const candidate = structuredClone(saved);
    candidate.preview.candidate.version = '2';
    expect(programmeInputFingerprint(candidate, 'assessment')).toBe(
      programmeInputFingerprint(saved, 'assessment'),
    );
    expect(
      programmeInputFingerprint(candidate, 'planning', 'assessment-a'),
    ).not.toBe(programmeInputFingerprint(saved, 'planning', 'assessment-a'));
    const target = structuredClone(saved);
    target.preview.selection.target.target_fraction = '0.2';
    expect(programmeInputFingerprint(target, 'assessment')).not.toBe(
      programmeInputFingerprint(saved, 'assessment'),
    );
    expect(
      programmeInputFingerprint(saved, 'planning', 'assessment-b'),
    ).not.toBe(programmeInputFingerprint(saved, 'planning', 'assessment-a'));
  });
  it('never follows a task current-run pointer when reopening an exact historical result', () => {
    const saved = snapshot(),
      linked = attempt(saved),
      task = taskFor(linked, 'completed');
    const outputContent = { result: 'Retained exact old-run product.' };
    const output = artifactSchema.parse({
      schema_version: 'haze.artifact.v3',
      id: randomUUID(),
      version: 1,
      sha256: contractHash(outputContent),
      identity,
      task_id: task.id,
      run_id: linked.run_id,
      objective_revision: 1,
      kind: 'saved.result',
      producer: { kind: 'service', id: 'fixture' },
      created_at: at,
      dependencies: [],
      content: outputContent,
    });
    const nextRun = {
      ...task.runs[0]!,
      id: randomUUID(),
      status: 'running' as const,
    };
    task.runs.push(nextRun);
    task.current_run_id = nextRun.id;
    task.status = 'running';
    const host = hostFor(task);
    host.runResult = (taskId, runId, _identity, objectiveRevision) => {
      expect([taskId, runId, objectiveRevision]).toEqual([
        task.id,
        linked.run_id,
        1,
      ]);
      return taskResultSchema.parse({
        schema_version: 'haze.task.result.v3',
        answer: 'Retained fixture gap.',
        completion: 'partial',
        work_products: [
          { id: output.id, version: output.version, sha256: output.sha256 },
        ],
        sources: [],
        covered_scope: {},
        uncertainty: [],
        review: {
          status: 'not_required',
          scope: 'Historical reference only.',
          limitations: [],
        },
        currency: 'current',
        next_requirements: [],
        provenance: {
          mode: 'fixture',
          model_calls: 3,
          tool_calls: 5,
          capabilities: [],
          receipts: [],
        },
      });
    };
    host.readArtifact = () => output;
    host.previewView = () => {
      throw new Error(
        'Must not read a successor run as the linked phase result.',
      );
    };
    const view = projectReductionProgramme(saved, [linked], [], host, identity);
    expect(view.attempts[0]).toMatchObject({
      execution_status: 'completed',
      currency: 'historical',
      preview: null,
      historical_artifact_refs: [
        { id: output.id, version: output.version, sha256: output.sha256 },
      ],
    });
    expect(view.capacity.remaining_model_calls).toBe(397);
  });
  it('rechecks held/withdrawn source availability without a programme revision', () => {
    const saved = snapshot(),
      linked = attempt(saved),
      host = hostFor(taskFor(linked));
    expect(
      projectReductionProgramme(saved, [linked], [], host, identity).attempts[0]
        ?.currency,
    ).toBe('current');
    host.assertEvidenceCurrent = () => {
      throw new Error('Source is held or withdrawn.');
    };
    expect(
      projectReductionProgramme(saved, [linked], [], host, identity)
        .attempts[0],
    ).toMatchObject({
      currency: 'stale',
      preview: null,
      reasons: ['Source is held or withdrawn.'],
    });
  });
});

describe('programme service revisions and bounded history', () => {
  it('creates idempotently without task execution and preserves freshness through notes', () => {
    const { repo } = repository(),
      host = hostFor(),
      service = new ReductionProgrammeService(repo, host),
      request = syntheticProgrammeCreateRequest(sourceRef);
    const created = service.create(request, 'create-key', identity);
    expect(service.create(request, 'create-key', identity)).toEqual(created);
    const before = service.read(created.programme_id, identity);
    const noted = service.appendRecord(
      created.programme_id,
      {
        schema_version: 'haze.reduction.programme.record-request.v1',
        expected_revision: 1,
        record: { kind: 'note', text: 'Unrelated operator note.' },
      },
      'note-key',
      identity,
    );
    const after = service.read(created.programme_id, identity);
    expect(noted.revision).toBe(2);
    expect(programmeInputFingerprint(before.programme, 'assessment')).toBe(
      programmeInputFingerprint(after.programme, 'assessment'),
    );
    expect(after.attempts).toEqual([]);
    expect(after.records[0]?.applicability).toBe('historical_context');
    expect(
      service.history(created.programme_id, identity, { limit: 1 }).next_offset,
    ).toBe(1);
  });
  it('rejects invalid pagination and stale programme revisions before mutation', () => {
    const { repo } = repository(),
      service = new ReductionProgrammeService(repo, hostFor()),
      request = syntheticProgrammeCreateRequest(sourceRef);
    const created = service.create(request, 'create-key', identity);
    expect(() => service.list(identity, { limit: 11 })).toThrow(
      expect.objectContaining({ code: 'invalid_programme_pagination' }),
    );
    expect(() =>
      service.history(created.programme_id, identity, { offset: -1 }),
    ).toThrow(
      expect.objectContaining({ code: 'invalid_programme_pagination' }),
    );
    expect(() =>
      service.revise(
        created.programme_id,
        {
          schema_version: 'haze.reduction.programme.revise.v1',
          expected_revision: 2,
          reason: 'Stale edit.',
          title: 'Wrong expectation',
        },
        'revise-key',
        identity,
      ),
    ).toThrow(expect.objectContaining({ code: 'programme_revision_conflict' }));
    expect(
      service.read(created.programme_id, identity).programme.revision,
    ).toBe(1);
  });
});
