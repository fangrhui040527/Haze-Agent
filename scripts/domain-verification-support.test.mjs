import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  domainModelEvidence,
  accountingDemonstrationGaps,
  domainVerificationEnvironment,
  readVerificationLineage,
} from './domain-verification-support.mjs';

const env = domainVerificationEnvironment({ SAMPLE_MODE: 'true' });
const model = env.HAZE_MODEL;
const task = {
  id: 'task',
  mode: 'live',
  assignments: [
    { id: 'manager', role: 'Manager' },
    { id: 'critic', role: 'EvidenceCritic' },
  ],
};
const attempt = (id, assignment = 'manager') => ({
  id,
  task_id: 'task',
  assignment_id: assignment,
  kind: 'model',
  status: 'completed',
  accepted: true,
  details: {
    requested_route: { provider: 'nightshift', requested_model: model },
  },
  receipt: {
    http_status: 200,
    response_status: 'stop',
    response_model: model,
    response_id: id,
  },
});

test('verification pins every model role to Ultra without mutating input environment', () => {
  const original = { HAZE_PROVIDER: 'offline', SAMPLE_MODE: 'true' };
  const result = domainVerificationEnvironment(original);
  assert.equal(original.SAMPLE_MODE, 'true');
  assert.equal(result.SAMPLE_MODE, 'false');
  assert.equal(result.HAZE_PROVIDER, 'nightshift');
  const profiles = JSON.parse(result.HAZE_MODEL_ROUTES_JSON).profiles;
  const routes = JSON.parse(result.HAZE_AGENT_ROUTES_JSON).routes;
  assert.equal(Object.keys(routes).length, 5);
  for (const profile of Object.values(routes)) {
    assert.equal(profiles[profile].model, model);
    assert.equal(profiles[profile].provider, 'nightshift');
  }
});

test('reports failed calls and deterministic zero-call roles separately', () => {
  const evidence = domainModelEvidence(task, [
    attempt('accepted'),
    { ...attempt('failed', 'critic'), status: 'failed', accepted: false },
    { ...attempt('unrelated'), task_id: 'other-task' },
  ]);
  assert.equal(evidence.strict_model_receipts, true);
  assert.equal(evidence.model_calls_by_role.Manager, 1);
  assert.equal(evidence.model_calls_by_role.EvidenceCritic, 1);
  assert.equal(evidence.accepted_model_calls_by_role.EvidenceCritic, 0);
  assert.equal(evidence.model_calls_by_role.DamageAccountant, 0);
});

test('rejects synthetic, missing, and substituted response identities', () => {
  for (const receipt of [
    { ...attempt('a').receipt, synthetic: true },
    { ...attempt('a').receipt, response_model: 'other-model' },
    { ...attempt('a').receipt, response_id: null },
    { ...attempt('a').receipt, response_status: 'length' },
  ])
    assert.equal(
      domainModelEvidence(task, [{ ...attempt('a'), receipt }])
        .strict_model_receipts,
      false,
    );
});

test('rejects fixture tasks, unknown roles, and absence of genuine Manager calls', () => {
  assert.equal(
    domainModelEvidence({ ...task, mode: 'fixture' }, [attempt('a')])
      .strict_model_receipts,
    false,
  );
  assert.equal(
    domainModelEvidence(task, [attempt('a', 'missing')]).strict_model_receipts,
    false,
  );
  assert.equal(domainModelEvidence(task, []).strict_model_receipts, false);
});

test('partial or empty accounts do not qualify as completed domain demonstrations', () => {
  const complete = {
    status: 'complete_for_declared_imported_scope',
    physical_totals: [{}],
    financing_totals: [{}],
    welfare_totals: [{}],
  };
  const completed = { result: { completion: 'full' } };
  assert.deepEqual(accountingDemonstrationGaps(completed, complete), []);
  assert.deepEqual(
    accountingDemonstrationGaps(
      { result: { completion: 'partial' } },
      {
        ...complete,
        status: 'gap',
        physical_totals: [],
      },
    ),
    [
      'damage_account_gap',
      'accounting_task_incomplete',
      'physical_outcomes_missing',
    ],
  );
  assert.deepEqual(accountingDemonstrationGaps(completed, undefined), [
    'damage_account_missing',
  ]);
});

const lineagePage = (entries, hasMore = false, cursor) => ({
  view: 'lineage',
  lineage: {
    record: { id: 'wm:test-record', revision: 1, sha256: 'a'.repeat(64) },
    entries,
    page: {
      limit: 50,
      has_more: hasMore,
      ...(cursor === undefined ? {} : { next_cursor: cursor }),
    },
  },
});

test('follows an empty scoped-event window to the retained acceptance and aggregates pages', async () => {
  const calls = [];
  const created = { event_id: 'record-created', event_kind: 'record_created' };
  const accepted = {
    event_id: 'acceptance',
    event_kind: 'acceptance_evaluated',
  };
  const pages = [
    lineagePage([], true, '1001'),
    lineagePage([created], true, '1400'),
    lineagePage([accepted]),
  ];
  const original = structuredClone(pages);
  const result = await readVerificationLineage(
    (_origin, path) => {
      calls.push(path);
      return Promise.resolve(pages[calls.length - 1]);
    },
    'http://localhost',
    '/api/world/records/test',
  );
  assert.deepEqual(calls, [
    '/api/world/records/test?view=lineage&limit=50',
    '/api/world/records/test?view=lineage&limit=50&cursor=1001',
    '/api/world/records/test?view=lineage&limit=50&cursor=1400',
  ]);
  assert.deepEqual(result.lineage.entries, [created, accepted]);
  assert.equal(result.lineage.page.has_more, false);
  assert.deepEqual(pages, original);
});

test('rejects missing, repeated, backwards and invalid successor cursors', async () => {
  for (const cursor of [undefined, '1001', '999', 'bad', '9007199254740992']) {
    let calls = 0;
    await assert.rejects(
      readVerificationLineage(
        () => {
          calls++;
          return Promise.resolve(
            lineagePage([], true, calls === 1 ? '1001' : cursor),
          );
        },
        'http://localhost',
        '/api/world/records/test',
      ),
      /lineage_cursor_not_advancing/u,
    );
    assert.equal(calls, 2);
  }
});

test('bounds pagination even when every empty window advances its cursor', async () => {
  let calls = 0;
  await assert.rejects(
    readVerificationLineage(
      () => {
        calls++;
        return Promise.resolve(lineagePage([], true, String(calls * 1001)));
      },
      'http://localhost',
      '/api/world/records/test',
      { maxPages: 2 },
    ),
    /lineage_page_bound_exceeded/u,
  );
  assert.equal(calls, 2);
});

test('rejects a changed record or duplicated event during pagination', async () => {
  for (const changedRecord of [true, false]) {
    let calls = 0;
    await assert.rejects(
      readVerificationLineage(
        () => {
          calls++;
          const page = lineagePage(
            [{ event_id: 'same-event' }],
            calls === 1,
            '1001',
          );
          if (changedRecord && calls === 2) page.lineage.record.revision++;
          return Promise.resolve(page);
        },
        'http://localhost',
        '/api/world/records/test',
      ),
      changedRecord
        ? /lineage_record_changed/u
        : /lineage_event_repeated_or_invalid/u,
    );
  }
});
