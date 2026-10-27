import type { Artifact, ArtifactRef } from '../../contracts/artifacts.js';
import {
  digitalServiceReceiptSchema,
  pilotDeliveryVerificationSchema,
  pilotExternalRegistrationSchema,
  pilotFeasibilitySchema,
  pilotProtocolSchema,
  pilotReviewSchema,
  pilotRecordBodySchema,
  pilotProgrammeProjectionSchema,
  type PilotRecordBody,
  type PilotRecordContext,
  type PilotProgrammeProjection,
  type PilotProtocol,
  type PilotFeasibility,
} from '../../contracts/damage-reduction-pilot.js';
import type {
  ReductionProgrammeRecord,
  ReductionProgrammeSnapshot,
} from '../../contracts/damage-reduction-programme.js';
import {
  canonicalJson,
  contractHash,
  parseContractJson,
} from '../../contracts/json.js';
import { TaskError } from '../../contracts/tasks.js';

const key = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const beforeWindow = (time: string, start: string) =>
  Date.parse(time) < Date.parse(`${start}T00:00:00Z`);
const withinWindow = (time: string, window: { start: string; end: string }) =>
  Date.parse(time) >= Date.parse(`${window.start}T00:00:00Z`) &&
  Date.parse(time) < Date.parse(`${window.end}T00:00:00Z`) + 86_400_000;
const body = (artifact: Artifact): unknown =>
  typeof artifact.content === 'string'
    ? parseContractJson(artifact.content)
    : artifact.content;
const kinds = new Set([
  'pilot_registration',
  'pilot_amendment',
  'digital_action',
  'pilot_deviation',
  'delivery_verification',
]);
export function isPilotRecord(value: unknown): value is PilotRecordBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    kinds.has(value.kind)
  );
}
function load(
  ref: ArtifactRef,
  context: PilotRecordContext,
  current = true,
): Artifact {
  const artifact = context.readArtifact(ref);
  if (
    artifact.identity.principal !== context.identity.principal ||
    artifact.identity.workspace !== context.identity.workspace
  )
    throw new TaskError(
      403,
      'pilot_source_identity',
      'Pilot records cannot cross principal or workspace boundaries.',
    );
  if (
    key(artifact) !== key(ref) ||
    contractHash(artifact.content) !== ref.sha256
  )
    throw new TaskError(
      409,
      'pilot_source_hash',
      'Pilot evidence must bind its exact original artifact version and hash.',
    );
  if (current) context.assertEvidenceCurrent(ref);
  return artifact;
}
function reviewedPair(
  protocolRef: ArtifactRef,
  reviewRef: ArtifactRef,
  feasibilityRef: ArtifactRef | null,
  programmeId: string,
  context: PilotRecordContext,
  current = true,
) {
  const protocolArtifact = load(protocolRef, context, current),
    reviewArtifact = load(reviewRef, context, current);
  const protocol = pilotProtocolSchema.parse(body(protocolArtifact)),
    review = pilotReviewSchema.parse(body(reviewArtifact));
  if (
    protocolArtifact.kind !== 'reduction.pilot-protocol' ||
    reviewArtifact.kind !== 'reduction.pilot-review'
  )
    throw new TaskError(
      409,
      'pilot_registered_product_required',
      'Registration requires exact registered protocol and independent-review products.',
    );
  if (
    protocol.programme_id !== programmeId ||
    review.programme_id !== programmeId
  )
    throw new TaskError(
      403,
      'pilot_programme_identity',
      'Pilot protocol/review belong to a different programme.',
    );
  if (
    review.verdict !== 'supported' ||
    !review.reviewed_artifacts.some((ref) => key(ref) === key(protocolRef)) ||
    key(review.input_ref) !== key(protocol.input_ref) ||
    reviewArtifact.producer.kind !== 'assignment' ||
    reviewArtifact.assignment_id !== review.reviewer.assignment_id ||
    reviewArtifact.assignment_revision !== review.reviewer.revision ||
    protocolArtifact.assignment_id === review.reviewer.assignment_id
  )
    throw new TaskError(
      409,
      'pilot_independent_review_required',
      'The exact protocol requires a supported independent registered review.',
    );
  let feasibility: PilotFeasibility | null = null;
  const possible = feasibilityRef
    ? [feasibilityRef]
    : review.reviewed_artifacts.filter((ref) => key(ref) !== key(protocolRef));
  for (const ref of possible) {
    const artifact = load(ref, context, current),
      parsed = pilotFeasibilitySchema.safeParse(body(artifact));
    if (parsed.success) {
      if (artifact.kind !== 'reduction.pilot-feasibility')
        throw new TaskError(
          409,
          'pilot_registered_product_required',
          'Feasibility must be an exact registered reviewed product.',
        );
      if (
        !review.reviewed_artifacts.some((item) => key(item) === key(ref)) ||
        parsed.data.programme_id !== programmeId ||
        key(parsed.data.input_ref) !== key(protocol.input_ref) ||
        artifact.assignment_id === review.reviewer.assignment_id ||
        parsed.data.target_sha256 !== protocol.target_sha256 ||
        parsed.data.scope_sha256 !== protocol.scope_sha256
      )
        throw new TaskError(
          409,
          'pilot_feasibility_lineage',
          'Reviewed feasibility and protocol must bind the same programme, input and target.',
        );
      feasibility = parsed.data;
      break;
    }
  }
  if (!feasibility)
    throw new TaskError(
      409,
      'pilot_feasibility_required',
      'The protocol review must cover an exact retained feasibility assessment.',
    );
  return { protocol, feasibility, review, protocolArtifact, reviewArtifact };
}
function referenced(record: PilotRecordBody): ArtifactRef[] {
  switch (record.kind) {
    case 'pilot_registration':
      return [
        record.feasibility_ref,
        record.protocol_ref,
        record.review_ref,
        ...record.outcome_access.evidence,
        ...(record.external_registration
          ? [record.external_registration.evidence]
          : []),
      ];
    case 'pilot_amendment':
      return [record.amended_protocol_ref, record.review_ref];
    case 'digital_action':
      return [
        ...record.trigger_refs,
        ...(record.receipt_ref ? [record.receipt_ref] : []),
      ];
    case 'pilot_deviation':
      return record.evidence;
    case 'delivery_verification':
      return [record.verification_ref];
  }
}
function amendmentFields(
  previous: PilotProtocol,
  next: PilotProtocol,
): string[] {
  const a = previous.specification,
    b = next.specification,
    changed: string[] = [];
  if (
    previous.target_sha256 !== next.target_sha256 ||
    previous.scope_sha256 !== next.scope_sha256 ||
    !same(a.target_rule, b.target_rule)
  )
    changed.push('target');
  for (const [field, oldValue, newValue] of [
    ['comparator', a.comparator, b.comparator],
    ['population', a.population, b.population],
    ['endpoint', [a.primary_endpoint, a.unit], [b.primary_endpoint, b.unit]],
    [
      'observation_window',
      [a.baseline_window, a.observation_window],
      [b.baseline_window, b.observation_window],
    ],
    ['analysis', a.analysis_method, b.analysis_method],
    ['missingness', a.missingness_rule, b.missingness_rule],
    ['deviations', a.deviation_rule, b.deviation_rule],
    ['stopping', a.stopping_criteria, b.stopping_criteria],
    [
      'digital_rule',
      a.digital_rule ? { ...a.digital_rule, scope: null } : null,
      b.digital_rule ? { ...b.digital_rule, scope: null } : null,
    ],
    [
      'operating_scope',
      a.digital_rule?.scope ?? null,
      b.digital_rule?.scope ?? null,
    ],
  ] as const)
    if (!same(oldValue, newValue)) changed.push(field);
  return changed;
}
function operationalRule(rule: PilotProtocol['specification']['digital_rule']) {
  return rule
    ? {
        kind: rule.kind,
        owner: rule.owner,
        trigger_rule: rule.trigger_rule,
        trigger_inputs: rule.trigger_inputs.map((item) => item.name),
        permitted_actions: rule.permitted_actions,
        scope: rule.scope,
        safeguards: rule.safeguards,
        pause_disable_rule: rule.pause_disable_rule,
      }
    : null;
}
export function validatePilotRecord(
  value: PilotRecordBody,
  snapshot: ReductionProgrammeSnapshot,
  records: readonly ReductionProgrammeRecord[],
  context: PilotRecordContext,
): void {
  const parsed = pilotRecordBodySchema.safeParse(value);
  if (!parsed.success)
    throw new TaskError(
      400,
      'invalid_pilot_record',
      'Supply one bounded typed pilot/delivery record with exact references.',
    );
  const record = parsed.data;
  // Delivery evidence can be retained despite stale/unavailable protocol support;
  // projection rechecks current eligibility, while identity/hash errors reject.
  for (const ref of referenced(record)) load(ref, context, false);
  if (record.kind === 'pilot_registration') {
    const access = record.outcome_access;
    if (
      (access.collection === 'not_started' &&
        access.collection_started_at !== null) ||
      (access.analysis === 'not_started' &&
        access.analysis_started_at !== null) ||
      Date.parse(access.attested_at) > Date.parse(context.now) ||
      [access.collection_started_at, access.analysis_started_at].some(
        (time) =>
          time !== null && Date.parse(time) > Date.parse(access.attested_at),
      )
    )
      throw new TaskError(
        409,
        'pilot_outcome_timing_conflict',
        'Outcome-stage and timestamp attestations must agree and cannot be future-dated.',
      );
    reviewedPair(
      record.protocol_ref,
      record.review_ref,
      record.feasibility_ref,
      snapshot.id,
      context,
    );
  }
  if (record.kind === 'pilot_amendment') {
    const registration = records.find(
      (item) =>
        item.id === record.registration_id &&
        item.record.kind === 'pilot_registration',
    );
    if (!registration || registration.record.kind !== 'pilot_registration')
      throw new TaskError(
        409,
        'pilot_registration_required',
        'An amendment must identify an existing immutable protocol registration.',
      );
    const amended = reviewedPair(
      record.amended_protocol_ref,
      record.review_ref,
      null,
      snapshot.id,
      context,
    );
    const previousAmendment = records.findLast(
      (item) =>
        item.record.kind === 'pilot_amendment' &&
        item.record.registration_id === record.registration_id,
    );
    const previousRef =
      previousAmendment?.record.kind === 'pilot_amendment'
        ? previousAmendment.record.amended_protocol_ref
        : registration.record.protocol_ref;
    const previous = pilotProtocolSchema.parse(
      body(load(previousRef, context, false)),
    );
    const changed = amendmentFields(previous, amended.protocol);
    const oldRule = previous.specification.digital_rule,
      newRule = amended.protocol.specification.digital_rule;
    if (
      oldRule &&
      newRule &&
      oldRule.id === newRule.id &&
      oldRule.version === newRule.version &&
      !same(operationalRule(oldRule), operationalRule(newRule))
    )
      throw new TaskError(
        409,
        'pilot_rule_version_required',
        'A changed operational rule needs a new rule ID/version; proof/approval metadata cannot silently redefine an agreed version.',
      );
    if (
      changed.some(
        (field) => !(record.affected_fields as string[]).includes(field),
      )
    )
      throw new TaskError(
        409,
        'pilot_undeclared_amendment',
        'Every actual protocol/target/rule/scope change must appear in affected_fields; the original registered analysis remains immutable.',
      );
  }
  if (record.kind === 'digital_action') {
    const previous = records.find(
      (item) =>
        item.record.kind === 'digital_action' &&
        item.record.action_id === record.action_id,
    );
    if (previous?.record.kind === 'digital_action') {
      const stable = (
        action: Extract<PilotRecordBody, { kind: 'digital_action' }>,
      ) => ({
        action_version: action.action_version,
        permitted_action: action.permitted_action,
        action_kind: action.action_kind,
        rule: action.rule,
        scope: action.scope,
        mode: action.mode,
      });
      if (!same(stable(previous.record), stable(record)))
        throw new TaskError(
          409,
          'pilot_action_identity_conflict',
          'A logical action ID cannot change version, permitted payload, kind, rule, scope or simulation/live origin. Use a new action ID for a different action.',
        );
    }
  }
  if (record.kind === 'digital_action' && record.reconciles_record_id) {
    const previous = records.find(
      (item) => item.id === record.reconciles_record_id,
    );
    if (
      !previous ||
      previous.record.kind !== 'digital_action' ||
      previous.record.action_id !== record.action_id
    )
      throw new TaskError(
        409,
        'pilot_reconciliation_lineage',
        'Reconciliation must name a retained event for the same exact action ID.',
      );
  }
  if (record.kind === 'pilot_deviation' && record.resolves_deviation_id) {
    const previous = records.find(
      (item) => item.id === record.resolves_deviation_id,
    );
    if (
      !previous ||
      previous.record.kind !== 'pilot_deviation' ||
      previous.record.registration_id !== record.registration_id ||
      !same(
        [...previous.record.action_record_ids].sort(),
        [...record.action_record_ids].sort(),
      ) ||
      (previous.record.material && !record.material)
    )
      throw new TaskError(
        409,
        'pilot_deviation_lineage',
        'A resolution must identify an existing deviation.',
      );
  }
}
function protocolCurrent(
  protocol: PilotProtocol,
  snapshot: ReductionProgrammeSnapshot,
  context: PilotRecordContext,
): string[] {
  const reasons: string[] = [];
  if (
    protocol.programme_id !== snapshot.id ||
    protocol.target_sha256 !==
      contractHash(snapshot.preview.selection.target) ||
    protocol.scope_sha256 !==
      contractHash(snapshot.preview.selection.target.scope)
  )
    reasons.push(
      'Registered protocol does not match the current programme target/scope.',
    );
  if (
    snapshot.pilot_input_ref &&
    key(protocol.input_ref) !== key(snapshot.pilot_input_ref)
  )
    reasons.push('Registered protocol uses a different pilot input version.');
  const lineage =
    context.current_lineage ?? context.current_draft?.protocol.value;
  if (
    !lineage ||
    key(protocol.selection_ref) !== key(lineage.selection_ref) ||
    key(protocol.assessment_ref) !== key(lineage.assessment_ref) ||
    key(protocol.plan_ref) !== key(lineage.plan_ref) ||
    key(protocol.plan_review_ref) !== key(lineage.plan_review_ref)
  )
    reasons.push(
      'Current reviewed assessment/planning lineage differs or is unavailable; this protocol cannot inherit a later result implicitly.',
    );
  const spec = protocol.specification,
    target = snapshot.preview.selection.target;
  if (
    spec.primary_endpoint !== target.scope.endpoint ||
    spec.unit !== target.scope.unit ||
    spec.population !== target.scope.population ||
    spec.comparator !== target.comparator ||
    !same(spec.observation_window, target.scope.period) ||
    !same(spec.target_rule, {
      fraction: target.target_fraction,
      relation: target.relation,
      assessment_rule: target.assessment_rule,
    })
  )
    reasons.push(
      'Protocol endpoint, comparator, observation window or criterion is incomplete/incompatible.',
    );
  return reasons;
}
function contains(
  outer: NonNullable<PilotProtocol['specification']['digital_rule']>['scope'],
  inner: NonNullable<PilotProtocol['specification']['digital_rule']>['scope'],
) {
  return (
    outer.geography === inner.geography &&
    outer.population === inner.population &&
    outer.period.start <= inner.period.start &&
    outer.period.end >= inner.period.end &&
    inner.recipient_groups.every((group) =>
      outer.recipient_groups.includes(group),
    ) &&
    inner.schedule_ids.every((schedule) =>
      outer.schedule_ids.includes(schedule),
    )
  );
}
function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Pilot evidence is unavailable.';
}
function synthetic(artifact: Artifact, value: unknown) {
  return (
    artifact.evidence_origin === 'synthetic_fixture' ||
    (typeof value === 'object' &&
      value !== null &&
      'origin' in value &&
      (value.origin === 'synthetic' || value.origin === 'synthetic_fixture'))
  );
}
function proofHasSynthetic(
  refs: readonly ArtifactRef[],
  context: PilotRecordContext,
  current = true,
): boolean {
  const checked = new Set<string>(),
    visiting = new Set<string>();
  let found = false;
  const visit = (ref: ArtifactRef): void => {
    const id = key(ref);
    if (visiting.has(id))
      throw new TaskError(
        409,
        'pilot_proof_cycle',
        'Delivery proof dependencies must form a bounded DAG.',
      );
    if (checked.has(id)) return;
    if (checked.size + visiting.size >= 256)
      throw new TaskError(
        409,
        'pilot_proof_bound',
        'Delivery proof closure exceeds 256 exact artifacts.',
      );
    const artifact = load(ref, context, current);
    let value: unknown = null;
    try {
      value = body(artifact);
    } catch {
      /* Retained prose has no machine origin override. */
    }
    found ||= synthetic(artifact, value);
    visiting.add(id);
    for (const dependency of artifact.dependencies) visit(dependency);
    visiting.delete(id);
    checked.add(id);
  };
  for (const ref of refs) visit(ref);
  return found;
}
type Registration = {
  stored: ReductionProgrammeRecord;
  body: Extract<PilotRecordBody, { kind: 'pilot_registration' }>;
  protocol: PilotProtocol;
  feasibility: PilotFeasibility;
  current: boolean;
};

/** Historical origin is a retained fact, even when another proof is unavailable. */
function historicalProofOrigin(
  refs: readonly ArtifactRef[],
  context: PilotRecordContext,
) {
  const checked = new Set<string>(),
    visiting = new Set<string>();
  let simulated = false,
    unavailable = false;
  const visit = (ref: ArtifactRef): void => {
    const id = key(ref);
    if (visiting.has(id)) {
      unavailable = true;
      return;
    }
    if (checked.has(id)) return;
    if (checked.size + visiting.size >= 256) {
      unavailable = true;
      return;
    }
    visiting.add(id);
    try {
      const artifact = load(ref, context, false);
      let value: unknown = null;
      try {
        value = body(artifact);
      } catch {
        /* Plain retained prose has no origin override. */
      }
      simulated ||= synthetic(artifact, value);
      const receipt = digitalServiceReceiptSchema.safeParse(value);
      // Receipt raw payloads are exact proof roots even when the wrapper did
      // not also list them in its ordinary artifact dependency metadata.
      if (receipt.success && receipt.data.raw_receipt_ref)
        visit(receipt.data.raw_receipt_ref);
      for (const dependency of artifact.dependencies) visit(dependency);
    } catch {
      unavailable = true;
    } finally {
      visiting.delete(id);
      checked.add(id);
    }
  };
  for (const ref of refs) visit(ref);
  return { simulated, unavailable };
}

/** Server projection preserves records; it never sends alerts or applies schedules. */
export function projectPilotRecords(
  snapshot: ReductionProgrammeSnapshot,
  records: readonly ReductionProgrammeRecord[],
  context: PilotRecordContext,
): PilotProgrammeProjection {
  const result: PilotProgrammeProjection = {
    feasibility: null,
    registrations: [],
    amendments: [],
    actions: [],
    deviations: [],
    verifications: [],
    reasons: [
      'Live service adapters are deferred. Imported receipts and human attestations are not provider authentication or evidence of achieved damage reduction.',
    ],
    live_delivery: 'deferred',
    scientific_qualification: 'unqualified',
    achieved_reduction: false,
  };
  const registrations = new Map<string, Registration>();
  let outcomesKnown = false,
    outcomesUnknown = false;
  if (context.current_draft) {
    try {
      const draft = context.current_draft;
      reviewedPair(
        draft.protocol.artifact,
        draft.review.artifact,
        draft.feasibility.artifact,
        snapshot.id,
        context,
      );
      result.feasibility = {
        classification: draft.feasibility.value.classification,
        origin: draft.feasibility.value.origin,
        current: true,
        prerequisites: draft.feasibility.value.prerequisites,
      };
    } catch (error) {
      result.reasons.push(errorText(error));
    }
  }
  for (const stored of records) {
    if (!isPilotRecord(stored.record)) continue;
    const record = stored.record;
    if (record.kind === 'pilot_registration') {
      const priorKnown = outcomesKnown,
        priorUnknown = outcomesUnknown;
      outcomesKnown ||=
        ['started', 'complete'].includes(record.outcome_access.collection) ||
        ['started', 'complete'].includes(record.outcome_access.analysis) ||
        record.outcome_access.collection_started_at !== null ||
        record.outcome_access.analysis_started_at !== null;
      outcomesUnknown ||=
        record.outcome_access.collection === 'unknown' ||
        record.outcome_access.analysis === 'unknown';
      const view: PilotProgrammeProjection['registrations'][number] = {
        record_id: stored.id,
        protocol_ref: record.protocol_ref,
        effective_protocol_ref: record.protocol_ref,
        recorded_at: stored.created_at,
        timing: 'unknown',
        currency: 'stale',
        analysis_status: 'original',
        reasons: [],
      };
      try {
        const resolved = reviewedPair(
          record.protocol_ref,
          record.review_ref,
          record.feasibility_ref,
          snapshot.id,
          context,
        );
        view.reasons.push(
          ...protocolCurrent(resolved.protocol, snapshot, context),
        );
        view.currency = view.reasons.length ? 'stale' : 'current';
        registrations.set(stored.id, {
          stored,
          body: record,
          protocol: resolved.protocol,
          feasibility: resolved.feasibility,
          current: view.currency === 'current',
        });
        const access = record.outcome_access,
          window = resolved.protocol.specification.observation_window;
        const ownKnown =
          ['started', 'complete'].includes(access.collection) ||
          ['started', 'complete'].includes(access.analysis) ||
          access.collection_started_at !== null ||
          access.analysis_started_at !== null;
        const ownUnknown =
          access.collection === 'unknown' || access.analysis === 'unknown';
        if (priorKnown || ownKnown) view.timing = 'late_or_outcome_aware';
        else if (
          !priorUnknown &&
          !ownUnknown &&
          Date.parse(access.attested_at) <= Date.parse(stored.created_at) &&
          window &&
          beforeWindow(stored.created_at, window.start) &&
          access.collection === 'not_started' &&
          access.analysis === 'not_started'
        )
          view.timing = 'attested_before_outcomes';
        if (record.external_registration) {
          const externalArtifact = load(
            record.external_registration.evidence,
            context,
          );
          const external = pilotExternalRegistrationSchema.parse(
            body(externalArtifact),
          );
          const externalSynthetic = proofHasSynthetic(
            [
              record.external_registration.evidence,
              ...external.evidence,
              ...access.evidence,
            ],
            context,
          );
          const earliest = [
            access.collection_started_at,
            access.analysis_started_at,
          ]
            .filter((item): item is string => item !== null)
            .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
          if (
            !priorKnown &&
            !priorUnknown &&
            external.origin !== 'synthetic' &&
            !externalSynthetic &&
            external.registry === record.external_registration.registry &&
            external.registered_at ===
              record.external_registration.registered_at &&
            external.protocol_sha256 === record.protocol_ref.sha256 &&
            Date.parse(external.registered_at) <=
              Date.parse(stored.created_at) &&
            Date.parse(access.attested_at) <= Date.parse(stored.created_at) &&
            ((earliest &&
              Date.parse(external.registered_at) < Date.parse(earliest) &&
              Date.parse(earliest) <= Date.parse(access.attested_at)) ||
              (!ownKnown &&
                !ownUnknown &&
                window &&
                beforeWindow(external.registered_at, window.start)))
          )
            view.timing = 'external_prior_registration_attested';
          else
            view.reasons.push(
              'External date is retained but does not establish earlier prespecification for this exact protocol.',
            );
        }
        if (priorKnown)
          view.reasons.push(
            'Earlier programme records already establish outcome access; later not-started flags cannot reset prespecification.',
          );
        if (view.timing === 'unknown')
          view.reasons.push(
            'Registration timing is unknown or too late for an uncorroborated not-started attestation.',
          );
        if (view.currency !== 'current') view.analysis_status = 'unknown';
        if (resolved.protocol.prerequisites.length) {
          view.reasons.push(
            'Registered protocol remains conditional/incomplete; timing does not establish a capable or qualified damage-evaluation design.',
            ...resolved.protocol.prerequisites.slice(0, 16),
          );
          if (resolved.protocol.prerequisites.length > 16)
            view.reasons.push(
              `${resolved.protocol.prerequisites.length - 16} additional prerequisites remain in the exact protocol artifact.`,
            );
        }
        if (
          !context.current_draft &&
          (!result.feasibility?.current || view.currency === 'current')
        )
          result.feasibility = {
            classification: resolved.feasibility.classification,
            origin: resolved.feasibility.origin,
            current: view.currency === 'current',
            prerequisites: resolved.feasibility.prerequisites,
          };
      } catch (error) {
        view.reasons.push(errorText(error));
      }
      result.registrations.push(view);
    } else if (record.kind === 'pilot_amendment') {
      const priorKnown = outcomesKnown,
        priorUnknown = outcomesUnknown;
      outcomesKnown ||= record.outcomes_available === 'yes';
      outcomesUnknown ||= record.outcomes_available === 'unknown';
      const view: PilotProgrammeProjection['amendments'][number] = {
        record_id: stored.id,
        registration_id: record.registration_id,
        status: 'stale',
        reasons: [],
      };
      try {
        const base = registrations.get(record.registration_id);
        if (!base)
          throw new Error(
            'Original registration is unavailable; amendment cannot substitute another protocol.',
          );
        const amended = reviewedPair(
          record.amended_protocol_ref,
          record.review_ref,
          null,
          snapshot.id,
          context,
        );
        view.reasons.push(
          ...protocolCurrent(amended.protocol, snapshot, context),
        );
        const window = amended.protocol.specification.observation_window;
        const exploratory =
          priorKnown ||
          priorUnknown ||
          record.outcomes_available !== 'no' ||
          !window ||
          !beforeWindow(stored.created_at, window.start) ||
          Date.parse(record.attested_at) > Date.parse(stored.created_at) ||
          amended.protocol.target_sha256 !== base.protocol.target_sha256 ||
          amended.protocol.scope_sha256 !== base.protocol.scope_sha256;
        view.status = view.reasons.length
          ? 'stale'
          : exploratory
            ? 'exploratory'
            : 'prospective_amendment_attested';
        if (exploratory)
          view.reasons.push(
            'Outcome-aware, post-window or unknown-timing changes remain amended/exploratory; the original registered analysis is preserved.',
          );
        base.protocol = amended.protocol;
        base.feasibility = amended.feasibility;
        base.current = view.status !== 'stale';
        const registration = result.registrations.find(
          (item) => item.record_id === record.registration_id,
        )!;
        registration.effective_protocol_ref = record.amended_protocol_ref;
        registration.analysis_status =
          view.status === 'stale'
            ? 'unknown'
            : exploratory
              ? 'exploratory'
              : 'prospective_amended';
        registration.currency = view.status === 'stale' ? 'stale' : 'current';
        if (
          !context.current_draft &&
          (!result.feasibility?.current || base.current)
        )
          result.feasibility = {
            classification: amended.feasibility.classification,
            origin: amended.feasibility.origin,
            current: base.current,
            prerequisites: amended.feasibility.prerequisites,
          };
      } catch (error) {
        view.reasons.push(errorText(error));
      }
      result.amendments.push(view);
    }
  }
  const actionRecords = records.filter(
    (stored) => stored.record.kind === 'digital_action',
  );
  const lastAction = new Map(
    actionRecords.map((stored) => [
      stored.record.kind === 'digital_action' ? stored.record.action_id : '',
      stored.id,
    ]),
  );
  const seenReceipts = new Map<string, string>();
  const unknown = new Map<string, string>();
  const simulatedIds = new Set<string>();
  for (const stored of actionRecords) {
    if (stored.record.kind !== 'digital_action') continue;
    const action = stored.record;
    if (action.mode === 'simulated') simulatedIds.add(action.action_id);
    // Origin is an immutable historical fact, even when its use is now held.
    // Only the explicit delivery-proof chain is inspected, not scenario inputs.
    let historicalUnavailable = false;
    {
      const historicalProof = [
        ...action.trigger_refs,
        ...(action.receipt_ref ? [action.receipt_ref] : []),
      ];
      if (action.registration_id) {
        const registration = records.find(
          (item) => item.id === action.registration_id,
        );
        if (registration?.record.kind === 'pilot_registration') {
          const protocols = [
            registration.record.protocol_ref,
            ...records.flatMap((item) =>
              item.record.kind === 'pilot_amendment' &&
              item.record.registration_id === action.registration_id
                ? [item.record.amended_protocol_ref]
                : [],
            ),
          ];
          for (const ref of protocols) {
            try {
              const parsed = pilotProtocolSchema.safeParse(
                  body(load(ref, context, false)),
                ),
                rule = parsed.success
                  ? parsed.data.specification.digital_rule
                  : null;
              if (
                rule &&
                same(action.rule, { id: rule.id, version: rule.version })
              )
                historicalProof.push(
                  ...rule.approval.evidence,
                  ...rule.trigger_inputs.flatMap((item) => item.evidence),
                );
            } catch {
              historicalUnavailable = true;
            }
          }
        }
      }
      const origin = historicalProofOrigin(historicalProof, context);
      historicalUnavailable ||= origin.unavailable;
      if (origin.simulated) simulatedIds.add(action.action_id);
    }
    // Immutable declarations survive failed/held evidence reads. Keep the
    // original unresolved event as the reconciliation anchor across replays.
    if (action.status === 'unknown' && !unknown.has(action.action_id))
      unknown.set(action.action_id, stored.id);
    let reconcilesUnknown = false;
    const view: PilotProgrammeProjection['actions'][number] = {
      record_id: stored.id,
      action_id: action.action_id,
      origin: action.mode === 'simulated' ? 'simulated' : 'unknown',
      effective_status:
        action.mode === 'simulated'
          ? 'simulated'
          : action.status === 'failed'
            ? 'failed'
            : action.status === 'proposed'
              ? 'proposed'
              : 'unknown',
      confirmation_level: 'none',
      recorded_delivery: false,
      independent_verification: 'none',
      currency: 'current',
      reasons: [],
    };
    try {
      for (const ref of referenced(action)) load(ref, context);
      let receiptValid = false;
      if (action.receipt_ref) {
        const receiptArtifact = load(action.receipt_ref, context),
          receipt = digitalServiceReceiptSchema.parse(body(receiptArtifact));
        if (synthetic(receiptArtifact, receipt)) {
          simulatedIds.add(action.action_id);
          view.origin = 'simulated';
        } else
          view.origin =
            receipt.origin === 'human_report'
              ? 'human_report'
              : 'imported_service';
        receiptValid =
          receipt.action_version === action.action_version &&
          receipt.permitted_action === action.permitted_action &&
          same(
            [...receipt.trigger_refs].sort((a, b) =>
              key(a).localeCompare(key(b)),
            ),
            [...action.trigger_refs].sort((a, b) =>
              key(a).localeCompare(key(b)),
            ),
          ) &&
          receipt.action_id === action.action_id &&
          same(receipt.rule, action.rule) &&
          receipt.action_kind === action.action_kind &&
          same(receipt.scope, action.scope) &&
          Date.parse(receipt.occurred_at) === Date.parse(action.occurred_at);
        if (!receiptValid)
          view.reasons.push(
            'Receipt action/rule/version/scope/timestamp does not match the exact recorded event.',
          );
        const receiptKey = `${receipt.service}:${receipt.receipt_id}`;
        if (
          seenReceipts.has(receiptKey) &&
          seenReceipts.get(receiptKey) !== action.reconciles_record_id
        ) {
          receiptValid = false;
          view.reasons.push(
            'Duplicate service receipt is retained without duplicating confirmed delivery.',
          );
        } else seenReceipts.set(receiptKey, stored.id);
        if (receipt.raw_receipt_ref) load(receipt.raw_receipt_ref, context);
        view.confirmation_level = receipt.confirmation_level;
        if (receiptValid && view.origin === 'imported_service') {
          if (
            receipt.status === 'accepted' &&
            receipt.confirmation_level === 'provider_accepted'
          )
            view.effective_status = 'submitted';
          else if (receipt.status === 'failed')
            view.effective_status = 'failed';
          else if (
            receipt.status === 'confirmed' &&
            ((action.action_kind === 'exposure_alert' &&
              ['alert_transmitted', 'alert_received'].includes(
                receipt.confirmation_level,
              )) ||
              (action.action_kind === 'work_schedule' &&
                receipt.confirmation_level === 'schedule_applied'))
          )
            view.effective_status = 'confirmed';
          else
            view.reasons.push(
              'Receipt does not establish transmission, receipt or an applied schedule at the stated level.',
            );
        } else if (view.origin === 'human_report')
          view.reasons.push(
            'Human reports supplement evidence and cannot replace service confirmation.',
          );
      } else if (action.mode !== 'simulated')
        view.reasons.push(
          'Service receipt is missing; the declared status alone cannot confirm delivery.',
        );
      if (action.mode === 'simulated') simulatedIds.add(action.action_id);
      if (simulatedIds.has(action.action_id)) {
        view.origin = 'simulated';
        view.effective_status = 'simulated';
        view.reasons.push(
          'A simulation remains simulated regardless of later status flags or attached receipts.',
        );
      }
      if (Date.parse(action.occurred_at) > Date.parse(stored.created_at)) {
        if (view.effective_status !== 'simulated')
          view.effective_status = 'unknown';
        view.reasons.push(
          'Future-dated imported action cannot establish an action already delivered.',
        );
      }
      const unresolved = unknown.get(action.action_id);
      if (
        unresolved &&
        (action.reconciles_record_id !== unresolved ||
          !receiptValid ||
          !['confirmed', 'failed'].includes(view.effective_status))
      ) {
        if (view.effective_status !== 'simulated')
          view.effective_status = 'unknown';
        view.reasons.push(
          'Unknown outcome requires exact receipt reconciliation before replay or confirmed reuse.',
        );
      }
      if (action.status === 'unknown' && !action.reconciles_record_id) {
        if (view.effective_status !== 'simulated')
          view.effective_status = 'unknown';
        if (!unknown.has(action.action_id))
          unknown.set(action.action_id, stored.id);
      } else if (view.effective_status === 'unknown') {
        if (!unknown.has(action.action_id))
          unknown.set(action.action_id, stored.id);
      } else if (
        unresolved &&
        action.reconciles_record_id === unresolved &&
        receiptValid &&
        ['confirmed', 'failed'].includes(view.effective_status)
      )
        reconcilesUnknown = true;
      const registration = action.registration_id
        ? registrations.get(action.registration_id)
        : undefined;
      let governed = Boolean(registration?.current);
      const rule = registration?.protocol.specification.digital_rule;
      if (
        !rule ||
        !same(action.rule, { id: rule.id, version: rule.version }) ||
        action.action_kind !== rule.kind ||
        !contains(rule.scope, action.scope) ||
        !withinWindow(action.occurred_at, action.scope.period)
      ) {
        governed = false;
        view.reasons.push(
          'Protocol is missing/stale or the action differs from its agreed rule version, kind or operating scope.',
        );
      }
      if (
        !rule?.owner ||
        rule.approval.status !== 'approved' ||
        !rule.approval.approver ||
        !rule.approval.approved_at ||
        Date.parse(rule.approval.approved_at) >
          Date.parse(action.occurred_at) ||
        !rule.approval.evidence.length ||
        !rule.trigger_rule ||
        !rule.permitted_actions.includes(action.permitted_action) ||
        !action.trigger_refs.length
      ) {
        governed = false;
        view.reasons.push(
          'Rule ownership, retained approval, scoped trigger or permitted actions are incomplete.',
        );
      }
      const liveProof = [
        ...action.trigger_refs,
        ...(action.receipt_ref ? [action.receipt_ref] : []),
        ...(rule?.approval.evidence ?? []),
        ...(rule?.trigger_inputs.flatMap((item) => item.evidence) ?? []),
      ];
      if (action.receipt_ref) {
        const parsed = digitalServiceReceiptSchema.safeParse(
          body(load(action.receipt_ref, context)),
        );
        if (parsed.success && parsed.data.raw_receipt_ref)
          liveProof.push(parsed.data.raw_receipt_ref);
      }
      if (proofHasSynthetic(liveProof, context)) {
        simulatedIds.add(action.action_id);
        view.origin = 'simulated';
        view.effective_status = 'simulated';
        view.reasons.push(
          'Synthetic raw receipts, triggers or rule-approval proofs cannot establish live delivery.',
        );
      }
      if (lastAction.get(action.action_id) !== stored.id)
        view.reasons.push(
          'A later event for this logical action is retained as the current action state.',
        );
      view.recorded_delivery =
        view.origin === 'imported_service' &&
        view.effective_status === 'confirmed' &&
        governed &&
        lastAction.get(action.action_id) === stored.id;
    } catch (error) {
      view.currency = 'stale';
      view.recorded_delivery = false;
      view.reasons.push(errorText(error));
    }
    if (simulatedIds.has(action.action_id)) {
      view.origin = 'simulated';
      view.effective_status = 'simulated';
      view.recorded_delivery = false;
    } else if (historicalUnavailable) {
      view.origin = 'unknown';
      view.recorded_delivery = false;
      view.reasons.push(
        'Historical proof origin is incomplete or exceeds its bounded DAG; current live delivery is withheld.',
      );
    }
    if (
      reconcilesUnknown &&
      !historicalUnavailable &&
      view.currency === 'current' &&
      action.reconciles_record_id === unknown.get(action.action_id) &&
      ['confirmed', 'failed'].includes(view.effective_status)
    )
      unknown.delete(action.action_id);
    else if (
      view.effective_status === 'unknown' &&
      !unknown.has(action.action_id)
    )
      unknown.set(action.action_id, stored.id);
    result.actions.push(view);
  }
  for (const stored of records) {
    if (stored.record.kind !== 'pilot_deviation') continue;
    const deviation = stored.record;
    let resolved = false;
    const reasons: string[] = [];
    for (const candidate of records)
      if (
        candidate.record.kind === 'pilot_deviation' &&
        candidate.record.resolves_deviation_id === stored.id &&
        candidate.record.status === 'resolved' &&
        candidate.record.evidence.length
      ) {
        try {
          if (
            candidate.record.registration_id === deviation.registration_id &&
            same(
              [...candidate.record.action_record_ids].sort(),
              [...deviation.action_record_ids].sort(),
            ) &&
            (!deviation.material || candidate.record.material) &&
            !proofHasSynthetic(candidate.record.evidence, context)
          )
            resolved = true;
        } catch (error) {
          reasons.push(errorText(error));
        }
      }
    let ownProof = false;
    try {
      ownProof =
        Boolean(deviation.evidence.length) &&
        !proofHasSynthetic(deviation.evidence, context);
    } catch (error) {
      reasons.push(errorText(error));
    }
    result.deviations.push({
      record_id: stored.id,
      unresolved: deviation.resolves_deviation_id
        ? deviation.status !== 'resolved' || !ownProof
        : !resolved,
      material: deviation.material,
      reasons,
    });
  }
  for (const stored of records) {
    if (stored.record.kind !== 'delivery_verification') continue;
    const record = stored.record;
    const view: PilotProgrammeProjection['verifications'][number] = {
      record_id: stored.id,
      status: 'unsupported',
      covered_action_record_ids: [],
      reasons: [],
    };
    try {
      const artifact = load(record.verification_ref, context),
        verification = pilotDeliveryVerificationSchema.parse(body(artifact));
      const selectedEvidence = verification.actions
        .filter((item) => record.action_record_ids.includes(item.record_id))
        .flatMap((item) => item.evidence);
      const attestedAt = Date.parse(verification.verifier.attested_at);
      const precedesAction = record.action_record_ids.some((recordId) => {
        const action = records.find((item) => item.id === recordId)?.record;
        // A matching receipt binds this same occurrence time; a verifier
        // cannot attest its delivery before that action/confirmation exists.
        return (
          action?.kind === 'digital_action' &&
          attestedAt < Date.parse(action.occurred_at)
        );
      });
      const independent =
        verification.origin !== 'synthetic' &&
        !synthetic(artifact, verification) &&
        !proofHasSynthetic(
          [record.verification_ref, ...selectedEvidence],
          context,
        ) &&
        verification.verifier.independent &&
        verification.verifier.conflicts !== 'unresolved';
      let complete = independent;
      // Apply no action-level label until the whole supplied proof has passed
      // current-source and timing checks. A later failure cannot leave an
      // earlier action upgraded by a rejected/stale verification record.
      const covered: string[] = [];
      const upgrades: Array<{
        action: PilotProgrammeProjection['actions'][number];
        level: 'partial' | 'verified';
      }> = [];
      for (const recordId of record.action_record_ids) {
        const actionStored = records.find((item) => item.id === recordId),
          actionView = result.actions.find(
            (item) => item.record_id === recordId,
          ),
          item = verification.actions.find(
            (item) => item.record_id === recordId,
          );
        if (
          !actionStored ||
          actionStored.record.kind !== 'digital_action' ||
          !actionView ||
          !item ||
          item.action_id !== actionStored.record.action_id ||
          item.action_version !== actionStored.record.action_version ||
          item.permitted_action !== actionStored.record.permitted_action ||
          !same(
            [...item.trigger_refs].map(key).sort(),
            [...actionStored.record.trigger_refs].map(key).sort(),
          ) ||
          record.registration_id !== actionStored.record.registration_id ||
          !same(item.rule, actionStored.record.rule) ||
          !same(item.scope, actionStored.record.scope) ||
          item.confirmation_level !== actionView.confirmation_level ||
          !item.evidence.length
        ) {
          complete = false;
          view.reasons.push(
            'Verification omits or conflicts with an exact action/rule/scope/confirmation reference.',
          );
          continue;
        }
        for (const ref of item.evidence) load(ref, context);
        if (
          independent &&
          actionView.recorded_delivery &&
          item.verdict === 'verified'
        ) {
          covered.push(recordId);
          upgrades.push({ action: actionView, level: 'verified' });
        } else {
          complete = false;
          if (
            independent &&
            actionView.recorded_delivery &&
            ['partial', 'verified'].includes(item.verdict)
          )
            upgrades.push({ action: actionView, level: 'partial' });
        }
      }
      if (result.deviations.some((item) => item.material && item.unresolved)) {
        complete = false;
        view.reasons.push(
          'Unresolved material deviations prevent an unconditional verification conclusion.',
        );
        for (const upgrade of upgrades) upgrade.level = 'partial';
      }
      view.status =
        complete && covered.length === record.action_record_ids.length
          ? 'verified'
          : covered.length || independent
            ? 'partial'
            : 'unsupported';
      if (!independent)
        view.reasons.push(
          'Synthetic, conflicted or non-independent verification cannot establish independent delivery verification.',
        );
      if (attestedAt > Date.parse(stored.created_at) || precedesAction) {
        view.status = 'unsupported';
        view.reasons.push(
          precedesAction
            ? 'Verification attestation precedes a covered action/confirmation and cannot establish its delivery.'
            : 'Future-dated verification attestation is unavailable for current use.',
        );
      } else if (independent) {
        view.covered_action_record_ids = covered;
        const rank = { none: 0, partial: 1, verified: 2 } as const;
        for (const { action, level } of upgrades)
          if (rank[level] > rank[action.independent_verification])
            action.independent_verification = level;
      }
    } catch (error) {
      view.status = 'stale';
      view.reasons.push(errorText(error));
    }
    result.verifications.push(view);
  }
  return pilotProgrammeProjectionSchema.parse(result);
}
