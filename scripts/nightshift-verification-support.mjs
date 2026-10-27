import assert from 'node:assert/strict';

/** Policy selection is explicit; inspecting a cloud policy never submits work. */
export function nightshiftVerificationPolicy(privacy = 'local-only') {
  if (!['local-only', 'cloud-ok'].includes(privacy))
    throw new Error('--privacy must be local-only or cloud-ok.');
  return { privacy, max_spend_usd: privacy === 'local-only' ? 0 : null };
}

export function nightshiftPolicyReady(readiness, policy) {
  return Boolean(
    readiness.ready &&
    readiness.schema_compatible &&
    readiness.runtime_reachable &&
    readiness.schema_hash &&
    (policy.privacy === 'cloud-ok'
      ? readiness.cloud_enforced &&
        readiness.cloud_compute_available === true &&
        Array.isArray(readiness.cloud_lanes) &&
        readiness.cloud_lanes.length > 0
      : readiness.local_only_enforced &&
        readiness.local_compute_available === true),
  );
}

/** Native lane/model identities are evidence, independently of strict role routes. */
export function verifiedNativeAttempts(receipt, cloudLanes) {
  assert.equal(
    receipt.attempts.length,
    1,
    'One native attempt must be retained.',
  );
  const [attempt] = receipt.attempts;
  assert.ok(
    typeof attempt?.lane === 'string' &&
      attempt.lane.trim() &&
      typeof attempt.model === 'string' &&
      attempt.model.trim(),
    'Native completion must retain runtime-selected lane and model provenance.',
  );
  assert.equal(
    attempt.seq,
    receipt.winner_seq,
    'The retained native attempt must identify the captured winner.',
  );
  if (cloudLanes !== undefined)
    assert.ok(
      Array.isArray(cloudLanes) &&
        cloudLanes.some(
          (lane) =>
            lane.lane === attempt.lane &&
            lane.model === attempt.model &&
            lane.provider,
        ),
      'The selected native attempt must belong to the reviewed ready cloud roster.',
    );
  return receipt.attempts.map(({ seq, lane, model }) => ({ seq, lane, model }));
}
