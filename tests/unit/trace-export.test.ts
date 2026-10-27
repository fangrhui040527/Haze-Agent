import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  taskRequestSchema,
  type TaskIdentity,
} from '../../app/contracts/tasks.js';
import type { ArtifactRef } from '../../app/contracts/artifacts.js';
import { TaskStore } from '../../app/tasks/store.js';
import { createTraceSanitizer } from '../../app/tasks/trace-sanitize.js';
import { TraceExportService } from '../../app/tasks/trace-export.js';
import { traceRecordSchema } from '../../app/contracts/trace.js';

const identity: TaskIdentity = {
  principal: 'trace-test',
  workspace: 'trace-test',
};
const stores: TaskStore[] = [],
  roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (!rel || rel.startsWith('..')) throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
function setup(context_refs: ArtifactRef[] = [], existing?: TaskStore) {
  const store =
    existing ??
    new TaskStore(mkdtempSync(join(tmpdir(), 'haze-trace-export-')));
  if (!existing) {
    stores.push(store);
    roots.push(store.directory);
  }
  const task = store.admit(
    taskRequestSchema.parse({
      schema_version: 'haze.task.request.v3',
      objective: 'Verify trace evidence.',
      context_refs,
    }),
    identity,
    randomUUID(),
    { mode: 'fixture', tools: ['test.lookup'] },
  ).task;
  return {
    store,
    task,
    service: new TraceExportService(store, {
      env: { TEST_API_KEY: 'super-secret-value' },
    }),
  };
}
function control(
  store: TaskStore,
  taskId: string,
  action: 'cancel' | 'continue' | 'revoke',
) {
  const task = store.read(taskId, identity);
  return store.control(taskId, identity, randomUUID(), {
    schema_version: 'haze.task.control.v3',
    action,
    expected_run_id: task.current_run_id,
    expected_objective_revision: task.objective_revision,
    expected_generation: task.generation,
    expected_state_revision: task.state_revision,
  });
}
const ref = (artifact: ArtifactRef): ArtifactRef => ({
  id: artifact.id,
  version: artifact.version,
  sha256: artifact.sha256,
});

it('uses one policy for secrets, authorization, credential URLs and raw bodies', () => {
  const sanitizer = createTraceSanitizer({
    TEST_API_KEY: 'super-secret-value',
    FIRMS_MAP_KEY: 'private-map-key',
    OPEN_AQ_KEY: 'private-open-key',
  });
  const text = JSON.stringify(
    sanitizer.sanitize({
      authorization: 'Bearer hidden',
      password: 'hidden',
      source_location:
        'https://example.org/api/private-map-key/?key=private-open-key',
      message:
        'super-secret-value https://user:pass@example.org/a?token=hidden&ok=yes Bearer abc123',
      prompt: 'private copied source',
      receipt: { output: 'private copied source', actual_model: 'fixture' },
    }),
  );
  expect(text).not.toMatch(
    /super-secret-value|private-map-key|private-open-key|user:pass|hidden|abc123|private copied source/,
  );
  expect(text).toContain('actual_model');
  expect(text).toContain('ok=yes');
});

it('masks short secrets as tokens and preserves structural IDs, hashes and UTC timestamps', () => {
  const value = {
    event_id: 'trace:1',
    task_id: '11111111-1111-4111-8111-111111111111',
    sha256: '1'.repeat(64),
    at: '2026-01-01T01:01:01.000Z',
    note: 'password 1 and abc; abcdef is unrelated.',
    password: '1',
  };
  const masked = createTraceSanitizer({
    PASSWORD: '1',
    API_KEY: 'abc',
  }).sanitize(value);
  expect(masked).toEqual({
    ...value,
    note: 'password [redacted] and [redacted]; abcdef is unrelated.',
    password: '[redacted]',
  });
});

it('preserves typed trace enums when secrets collide while masking narrative and artifact content', () => {
  const { store, task } = setup();
  const source = store.listTraceRecords(
    task.id,
    task.current_run_id,
    identity,
  )[0]!;
  const record = traceRecordSchema.parse({
    ...source,
    status: 'completed',
    evidence_verdict: 'supported',
    task_status: 'completed',
    summary: 'fixture supported completed',
    details: { note: 'fixture', mode: 'fixture' },
    reviews: [
      {
        artifact: { id: randomUUID(), version: 1, sha256: 'a'.repeat(64) },
        producer_assignment_id: randomUUID(),
        producer_revision: 1,
        verdict: 'supported',
        limitations: ['supported'],
      },
    ],
  });
  const sanitizer = createTraceSanitizer({
    PASSWORD: 'fixture',
    API_KEY: 'supported',
    TEST_SECRET: 'completed',
  });
  const sanitized = traceRecordSchema.parse(sanitizer.sanitize(record));
  expect(sanitized.provenance.mode).toBe('fixture');
  expect(sanitized.provenance.capture).toBe('native');
  expect(sanitized.reviews?.[0]?.verdict).toBe('supported');
  expect(sanitized.reviews?.[0]?.limitations).toEqual(['[redacted]']);
  expect(sanitized.status).toBe('completed');
  expect(sanitized.summary).toBe('[redacted] [redacted] [redacted]');
  expect(sanitized.details).toEqual({ note: '[redacted]', mode: '[redacted]' });
  expect(sanitizer.sanitize({ mode: 'fixture', verdict: 'supported' })).toEqual(
    { mode: '[redacted]', verdict: '[redacted]' },
  );
});

it('paginates beyond 100 records without duplicates and isolates exact historical runs', () => {
  const { store, task, service } = setup();
  for (let index = 0; index < 205; index++)
    store.appendEvent(task.id, 'test_step', 'Runtime', `Step ${index}`);
  const first = service.page(task.id, task.current_run_id, identity);
  expect(first.records).toHaveLength(100);
  expect(first.has_more).toBe(true);
  const second = service.page(
    task.id,
    task.current_run_id,
    identity,
    first.next_cursor,
  );
  expect(second.records).toHaveLength(100);
  expect(second.records.every((item) => item.cursor > first.next_cursor)).toBe(
    true,
  );
  control(store, task.id, 'cancel');
  control(store, task.id, 'continue');
  const current = store.read(task.id, identity);
  store.appendEvent(task.id, 'new_run_only', 'Runtime', 'Current run only');
  const historical = service.bundle(task.id, task.current_run_id, identity);
  expect(historical.manifest.active_snapshot).toBe(false);
  expect(
    historical.records.every((item) => item.run_id === task.current_run_id),
  ).toBe(true);
  expect(JSON.stringify(historical)).not.toContain('new_run_only');
  expect(
    service.bundle(task.id, current.current_run_id, identity).manifest
      .active_snapshot,
  ).toBe(true);
  expect(() => service.page(task.id, randomUUID(), identity)).toThrow(
    'Run is not part',
  );
  expect(() =>
    service.page(task.id, current.current_run_id, {
      ...identity,
      principal: 'foreign',
    }),
  ).toThrow();
  expect(() =>
    service.page(task.id, current.current_run_id, identity, -1),
  ).toThrow();
  expect(() =>
    service.page(task.id, current.current_run_id, identity, 0, 101),
  ).toThrow();
});

it('withholds uploaded originals and copied text after revocation, and hashes only exported bytes', () => {
  const { store } = setup();
  const uploadedText = 'Private uploaded source body must never be disclosed.';
  const upload = store.importArtifact(
    {
      schema_version: 'haze.artifact.import.v3',
      filename: 'secret.md',
      media_type: 'text/markdown',
      content_base64: Buffer.from(uploadedText).toString('base64'),
    },
    identity,
    randomUUID(),
  ).artifact;
  const { task, service } = setup([ref(upload)], store);
  const artifact = store.saveArtifact(task.id, identity, {
    kind: 'test.fixture',
    producer: { kind: 'service', id: 'trace.fixture' },
    content: { value: 42, note: 'super-secret-value' },
    evidence_origin: 'synthetic_fixture',
  });
  store.appendEvent(task.id, 'test_copy', 'Runtime', uploadedText, {
    artifact: ref(artifact),
    prompt: uploadedText,
  });
  control(store, task.id, 'revoke');
  const bundle = service.bundle(task.id, task.current_run_id, identity);
  expect(JSON.stringify(bundle)).not.toContain(uploadedText);
  expect(JSON.stringify(bundle)).not.toContain('super-secret-value');
  expect(
    bundle.manifest.omissions.some((item) =>
      item.subject.startsWith(upload.id),
    ),
  ).toBe(true);
  const exported = bundle.artifacts.find(
    (item) => item.original_ref.id === artifact.id,
  )!;
  expect(exported.original_ref.sha256).toBe(artifact.sha256);
  expect(exported.exported_sha256).toBe(
    createHash('sha256')
      .update(`${JSON.stringify(exported.content)}\n`)
      .digest('hex'),
  );
  expect(exported.exported_sha256).not.toBe(artifact.sha256);
});

it('checks artifact grants at download time and labels missing historical capture', () => {
  const { store, task, service } = setup();
  const artifact = store.saveArtifact(task.id, identity, {
    kind: 'test.fixture',
    producer: { kind: 'service', id: 'trace.fixture' },
    content: { value: 42 },
    evidence_origin: 'synthetic_fixture',
    required_tools: ['test.lookup'],
  });
  store.appendEvent(task.id, 'test_evidence', 'Runtime', 'Evidence', {
    artifact: ref(artifact),
  });
  store.appendEvent(task.id, 'test_quote', 'Runtime', 'Protected quotation', {
    artifact: ref(artifact),
    note: 'Protected quotation',
  });
  const firstCursor = service.page(task.id, task.current_run_id, identity)
    .records[0]!.cursor;
  store.db.prepare('DELETE FROM trace_records WHERE cursor=?').run(firstCursor);
  control(store, task.id, 'revoke');
  const bundle = service.bundle(task.id, task.current_run_id, identity);
  expect(
    bundle.artifacts.some((item) => item.original_ref.id === artifact.id),
  ).toBe(false);
  expect(
    bundle.manifest.omissions.some(
      (item) => item.reason === 'permission_denied',
    ),
  ).toBe(true);
  expect(bundle.manifest.capture.reconstructed).toBe(1);
  expect(bundle.manifest.capture.omissions.length).toBeGreaterThan(0);
  expect(JSON.stringify(bundle)).not.toContain('Protected quotation');
});

it('rejects oversized evidence explicitly rather than dropping referenced content', () => {
  const { store, task, service } = setup();
  const artifact = store.saveArtifact(task.id, identity, {
    kind: 'test.fixture',
    producer: { kind: 'service', id: 'trace.fixture' },
    content: 'short',
    evidence_origin: 'synthetic_fixture',
  });
  store.appendEvent(task.id, 'test_evidence', 'Runtime', 'Evidence', {
    artifact: ref(artifact),
  });
  const original = store.artifact.bind(store);
  vi.spyOn(store, 'artifact').mockImplementation(
    (id, selectedIdentity, selectedRef) => ({
      ...original(id, selectedIdentity, selectedRef),
      content: 'x'.repeat(32 * 1024 * 1024 + 1),
    }),
  );
  expect(() => service.bundle(task.id, task.current_run_id, identity)).toThrow(
    '32 MiB',
  );
  expect(service.jsonl(task.id, task.current_run_id, identity)).toContain(
    'test_evidence',
  );
});

it('exports external originals only through trusted public-kind registration', () => {
  const { store, task, service } = setup();
  const source = store.saveArtifact(task.id, identity, {
    kind: 'test.registered-public',
    producer: { kind: 'service', id: 'test.public-source' },
    content: { public_value: 42 },
    evidence_origin: 'external_source',
  });
  store.appendEvent(task.id, 'test_evidence', 'Runtime', 'Public evidence', {
    artifact: ref(source),
  });
  const unsupported = service.bundle(task.id, task.current_run_id, identity);
  expect(
    unsupported.artifacts.some((item) => item.original_ref.id === source.id),
  ).toBe(false);
  expect(
    unsupported.manifest.omissions.some((item) =>
      item.subject.startsWith(source.id),
    ),
  ).toBe(true);
  const registered = new TraceExportService(store, {
    env: {},
    publicEvidenceKinds: ['test.registered-public'],
  }).bundle(task.id, task.current_run_id, identity);
  expect(
    registered.artifacts.find((item) => item.original_ref.id === source.id)
      ?.content,
  ).toEqual({ public_value: 42 });
});
