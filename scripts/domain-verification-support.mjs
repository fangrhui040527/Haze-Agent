import { createHash } from 'node:crypto';
import { NVIDIA_ULTRA_MODEL } from '../dist/release/nightshift-release.js';

const roles = [
  'Manager',
  'HazeOps',
  'WorkerShield',
  'EvidenceCritic',
  'DamageAccountant',
];

/** Freeze the same server-owned identities used by the isolated child before calls. */
export async function captureVerificationBindings(env) {
  const {
    createExecutionRegistry,
    createModelRouteRegistry,
    createNightshiftJobAdapter,
  } = await import('../dist/composition.js');
  const { currentReleaseBindings } =
    await import('../dist/release/nightshift-release.js');
  const { canonicalJson } = await import('../dist/contracts/json.js');
  try {
    const bindings = await currentReleaseBindings({
      registry: createExecutionRegistry({ mode: 'live', env }),
      modelRoutes: createModelRouteRegistry(env),
      nightshiftJobs: createNightshiftJobAdapter(env),
      signal: AbortSignal.timeout(10_000),
    });
    return bindings
      ? {
          release_bindings: bindings,
          bindings_sha256: retainedBytesHash(canonicalJson(bindings)),
        }
      : {
          release_bindings: null,
          bindings_sha256: null,
          binding_error: 'release_binding_capture_unavailable',
        };
  } catch {
    return {
      release_bindings: null,
      bindings_sha256: null,
      binding_error: 'release_binding_capture_unavailable',
    };
  }
}

/** Isolated verifier configuration; never edits the application's saved routes. */
export function domainVerificationEnvironment(env) {
  const profile = {
    provider: 'nightshift',
    model: NVIDIA_ULTRA_MODEL,
    base_url:
      env.HAZE_PROVIDER === 'nightshift'
        ? env.HAZE_PROVIDER_BASE_URL || 'http://127.0.0.1:8088/v1'
        : 'http://127.0.0.1:8088/v1',
    policy: 'provider-default',
  };
  return {
    ...env,
    SAMPLE_MODE: 'false',
    HAZE_PROVIDER: 'nightshift',
    HAZE_MODEL: NVIDIA_ULTRA_MODEL,
    HAZE_PROVIDER_BASE_URL: profile.base_url,
    HAZE_MODEL_ROUTES_JSON: JSON.stringify({
      version: 1,
      profiles: { 'verification-ultra': profile },
    }),
    HAZE_AGENT_ROUTES_JSON: JSON.stringify({
      version: 1,
      routes: Object.fromEntries(
        roles.map((role) => [role, 'verification-ultra']),
      ),
    }),
  };
}

/** Count charged attempts, including failed/unknown calls; never infer calls from plans. */
export function domainModelEvidence(task, attempts) {
  const assignments = new Map(
    task.assignments.map((entry) => [entry.id, entry]),
  );
  const calls = attempts.filter(
    (entry) => entry.task_id === task.id && entry.kind === 'model',
  );
  const counts = Object.fromEntries(roles.map((role) => [role, 0]));
  const accepted = Object.fromEntries(roles.map((role) => [role, 0]));
  const failures = [];
  for (const attempt of calls) {
    const role = assignments.get(attempt.assignment_id)?.role;
    if (!roles.includes(role)) {
      failures.push(`unknown_model_assignment:${attempt.id}`);
      continue;
    }
    counts[role]++;
    const route = attempt.details?.requested_route;
    if (
      route?.provider !== 'nightshift' ||
      route?.requested_model !== NVIDIA_ULTRA_MODEL
    )
      failures.push(`strict_requested_route:${attempt.id}`);
    if (attempt.status !== 'completed' || attempt.accepted !== true) continue;
    const receipt = attempt.receipt;
    if (
      receipt?.synthetic === true ||
      receipt?.http_status !== 200 ||
      receipt?.response_status !== 'stop' ||
      receipt?.response_model !== NVIDIA_ULTRA_MODEL ||
      typeof receipt?.response_id !== 'string' ||
      receipt.response_id.length === 0
    ) {
      failures.push(`strict_response_receipt:${attempt.id}`);
      continue;
    }
    accepted[role]++;
  }
  if (task.mode !== 'live') failures.push('live_task_required');
  if (accepted.Manager === 0) failures.push('genuine_manager_receipt_required');
  return {
    exact_model: NVIDIA_ULTRA_MODEL,
    model_calls_by_role: counts,
    accepted_model_calls_by_role: accepted,
    strict_model_receipts: failures.length === 0,
    failures,
  };
}

export function artifactEvidence(artifacts) {
  return artifacts.map(({ id, version, sha256, kind }) => ({
    id,
    version,
    sha256,
    kind,
  }));
}

/**
 * Lineage pages scan a bounded window of scoped events before filtering for
 * the requested record. An empty page can therefore still have a successor.
 * Aggregate only for verifier reporting; the server's pagination is unchanged.
 */
export async function readVerificationLineage(
  read,
  origin,
  recordPath,
  { limit = 50, maxPages = 32 } = {},
) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 32
  )
    throw new Error('lineage_pagination_bounds_invalid');
  let cursor = 0;
  let first;
  let subject;
  const entries = [];
  const seen = new Set();
  for (let index = 0; index < maxPages; index++) {
    const query = new URLSearchParams({
      view: 'lineage',
      limit: String(limit),
      ...(cursor ? { cursor: String(cursor) } : {}),
    });
    const response = await read(origin, `${recordPath}?${query}`);
    const lineage = response?.lineage;
    if (
      response?.view !== 'lineage' ||
      !Array.isArray(lineage?.entries) ||
      lineage.entries.length > limit ||
      typeof lineage.page?.has_more !== 'boolean'
    )
      throw new Error('lineage_page_invalid');
    const record = lineage.record;
    const current =
      record && `${record.id}:${record.revision}:${record.sha256}`;
    if (!current || (subject && subject !== current))
      throw new Error('lineage_record_changed');
    subject = current;
    first ??= response;
    for (const entry of lineage.entries) {
      if (typeof entry?.event_id !== 'string' || seen.has(entry.event_id))
        throw new Error('lineage_event_repeated_or_invalid');
      seen.add(entry.event_id);
      entries.push(entry);
    }
    if (!lineage.page.has_more)
      return {
        ...first,
        lineage: { ...first.lineage, entries, page: lineage.page },
      };
    const next = lineage.page.next_cursor;
    if (
      typeof next !== 'string' ||
      !/^\d{1,16}$/u.test(next) ||
      !Number.isSafeInteger(Number(next)) ||
      Number(next) <= cursor
    )
      throw new Error('lineage_cursor_not_advancing');
    cursor = Number(next);
  }
  throw new Error('lineage_page_bound_exceeded');
}

export function accountingDemonstrationGaps(task, account) {
  const gaps = [];
  if (!account) return ['damage_account_missing'];
  if (account.status !== 'complete_for_declared_imported_scope')
    gaps.push(`damage_account_${account.status}`);
  if (task.result?.completion !== 'full')
    gaps.push('accounting_task_incomplete');
  if (!account.physical_totals.length) gaps.push('physical_outcomes_missing');
  if (!account.financing_totals.length)
    gaps.push('financial_incidence_missing');
  if (!account.welfare_totals.length) gaps.push('welfare_totals_missing');
  return gaps;
}

export const retainedBytesHash = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
