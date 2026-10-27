import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nightshiftPolicyReady,
  nightshiftVerificationPolicy,
  verifiedNativeAttempts,
} from './nightshift-verification-support.mjs';

test('native verification keeps local-only default and explicitly selects uncapped cloud', () => {
  assert.deepEqual(nightshiftVerificationPolicy(), {
    privacy: 'local-only',
    max_spend_usd: 0,
  });
  assert.deepEqual(nightshiftVerificationPolicy('cloud-ok'), {
    privacy: 'cloud-ok',
    max_spend_usd: null,
  });
  assert.throws(() => nightshiftVerificationPolicy('cloud'), /--privacy/u);
});

test('cloud readiness does not depend on an installed local model', () => {
  const ready = {
    ready: true,
    schema_compatible: true,
    runtime_reachable: true,
    schema_hash: 'hash',
    cloud_enforced: true,
    cloud_compute_available: true,
    cloud_lanes: [
      { lane: 'cloud-lane', provider: 'nvidia', model: 'runtime-selected' },
    ],
    local_only_enforced: true,
    local_compute_available: false,
  };
  assert.equal(
    nightshiftPolicyReady(ready, nightshiftVerificationPolicy('cloud-ok')),
    true,
  );
  assert.equal(
    nightshiftPolicyReady(ready, nightshiftVerificationPolicy()),
    false,
  );
  for (const field of [
    'ready',
    'schema_compatible',
    'runtime_reachable',
    'cloud_enforced',
    'cloud_compute_available',
  ])
    assert.equal(
      nightshiftPolicyReady(
        { ...ready, [field]: false },
        nightshiftVerificationPolicy('cloud-ok'),
      ),
      false,
    );
});

test('cloud verification requires the selected attempt to belong to the inspected cloud roster', () => {
  const receipt = {
    winner_seq: 1,
    attempts: [{ seq: 1, lane: 'cloud-lane', model: 'runtime-selected' }],
  };
  const cloud = [
    { lane: 'cloud-lane', model: 'runtime-selected', provider: 'nvidia' },
  ];
  assert.deepEqual(verifiedNativeAttempts(receipt, cloud), receipt.attempts);
  assert.throws(() => verifiedNativeAttempts(receipt, []), /cloud roster/u);
  assert.throws(
    () =>
      verifiedNativeAttempts(receipt, [{ ...cloud[0], lane: 'local-lane' }]),
    /cloud roster/u,
  );
  assert.throws(
    () =>
      verifiedNativeAttempts(receipt, [
        { ...cloud[0], model: 'changed-model' },
      ]),
    /cloud roster/u,
  );
});

test('a native receipt must retain one resolved lane/model and its winner identity', () => {
  const receipt = {
    winner_seq: 1,
    attempts: [{ seq: 1, lane: 'cloud-lane', model: 'runtime-selected' }],
  };
  assert.deepEqual(verifiedNativeAttempts(receipt), receipt.attempts);
  assert.throws(() => verifiedNativeAttempts({ ...receipt, attempts: [] }));
  assert.throws(() => verifiedNativeAttempts({ ...receipt, winner_seq: 2 }));
  assert.throws(() =>
    verifiedNativeAttempts({
      ...receipt,
      attempts: [{ seq: 1, lane: 'cloud-lane', model: null }],
    }),
  );
});
