import {
  artifactRefSchema,
  type Artifact,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import {
  externalEvaluationInputSchema,
  evaluationRecordBodySchema,
  programmeEvaluationProjectionSchema,
  type EvaluationMethodContext,
  type EvaluationRecordBody,
  type ProgrammeEvaluationProjection,
} from '../../contracts/damage-reduction-evaluation.js';
import { pilotProtocolSchema } from '../../contracts/damage-reduction-pilot.js';
import type {
  ReductionProgrammeRecord,
  ReductionProgrammeSnapshot,
  ReductionProgrammeView,
} from '../../contracts/damage-reduction-programme.js';
import {
  canonicalJson,
  contractHash,
  parseContractJson,
} from '../../contracts/json.js';
import { TaskError, type TaskIdentity } from '../../contracts/tasks.js';
import {
  evaluationInputEvidenceReferences,
  evaluationDossierEvidenceReferences,
  inspectEvaluationDossier,
  EVALUATION_LIMITATIONS,
} from './evaluation-methods.js';
import { scientificQualificationDossierSchema } from '../../contracts/damage-reduction-evaluation.js';
import { projectPilotRecords } from './pilot-records.js';
import { buildPilotRecordContext } from './projection.js';
import type { ProgrammeHost } from './ports.js';

const key = (ref: ArtifactRef) => `${ref.id}:${ref.version}:${ref.sha256}`;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export const evaluationContent = (artifact: Artifact): unknown =>
  typeof artifact.content === 'string'
    ? parseContractJson(artifact.content)
    : artifact.content;
const unique = (values: readonly string[]) => [...new Set(values)];
export const isEvaluationRecord = (
  value: unknown,
): value is EvaluationRecordBody =>
  evaluationRecordBodySchema.safeParse(value).success;

/** Exact references in retained domain records are factual context, never instructions. */
export function embeddedEvaluationReferences(
  value: unknown,
  depth = 0,
): ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>(),
    ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, level: number): void => {
    if (level > 24 || ++nodes > 1_048_576)
      throw new TaskError(
        422,
        'programme_context_bound',
        'Evaluation context exceeds its supported nesting or value bound.',
      );
    if (!item || typeof item !== 'object') return;
    if (ancestors.has(item))
      throw new TaskError(
        409,
        'programme_source_cycle',
        'Evaluation evidence cannot contain a cyclic object.',
      );
    if ('id' in item && 'version' in item && 'sha256' in item) {
      const parsed = artifactRefSchema.safeParse({
        id: item.id,
        version: item.version,
        sha256: item.sha256,
      });
      if (!parsed.success)
        throw new TaskError(
          409,
          'programme_source_mismatch',
          'An embedded artifact reference has an invalid ID, version or hash.',
        );
      refs.set(key(parsed.data), parsed.data);
      if (refs.size > 128)
        throw new TaskError(
          422,
          'programme_context_bound',
          'Evaluation evidence exceeds 128 retained references.',
        );
      return;
    }
    ancestors.add(item);
    for (const child of Object.values(item)) visit(child, level + 1);
    ancestors.delete(item);
  };
  visit(value, depth);
  return [...refs.values()];
}

/** Material proof closure is bounded, exact and current; back-edges fail closed. */
export function collectEvaluationEvidence(
  refs: readonly ArtifactRef[],
  host: Pick<ProgrammeHost, 'readArtifact' | 'assertEvidenceCurrent'>,
  identity: TaskIdentity,
): Artifact[] {
  const evidence = new Map<string, Artifact>(),
    visiting = new Set<string>();
  const visit = (value: ArtifactRef): void => {
    const parsed = artifactRefSchema.safeParse(value);
    if (!parsed.success)
      throw new TaskError(
        409,
        'programme_source_mismatch',
        'Evaluation evidence requires an exact valid artifact reference.',
      );
    const reference = parsed.data,
      referenceKey = key(reference);
    if (visiting.has(referenceKey))
      throw new TaskError(
        409,
        'programme_source_cycle',
        'Evaluation evidence contains a cyclic source dependency.',
      );
    if (evidence.has(referenceKey)) return;
    if (evidence.size + visiting.size >= 128)
      throw new TaskError(
        422,
        'programme_context_bound',
        'Evaluation evidence exceeds 128 retained references.',
      );
    host.assertEvidenceCurrent(reference, identity);
    const artifact = host.readArtifact(reference, identity);
    if (
      artifact.identity.principal !== identity.principal ||
      artifact.identity.workspace !== identity.workspace
    )
      throw new TaskError(
        403,
        'programme_source_identity',
        'Evaluation evidence cannot cross principal or workspace boundaries.',
      );
    if (
      key(artifact) !== referenceKey ||
      contractHash(artifact.content) !== reference.sha256
    )
      throw new TaskError(
        409,
        'programme_source_mismatch',
        'Evaluation evidence no longer matches its exact reference.',
      );
    visiting.add(referenceKey);
    for (const dependency of artifact.dependencies) visit(dependency);
    let content: unknown = null;
    try {
      content = evaluationContent(artifact);
    } catch {
      /* Prose originals contain no structured source references. */
    }
    for (const nested of embeddedEvaluationReferences(content)) visit(nested);
    visiting.delete(referenceKey);
    evidence.set(referenceKey, artifact);
  };
  for (const reference of refs) visit(reference);
  return [...evidence.values()];
}

function syntheticProof(artifacts: readonly Artifact[]): boolean {
  return artifacts.some((artifact) => {
    if (artifact.evidence_origin === 'synthetic_fixture') return true;
    try {
      const value = evaluationContent(artifact);
      return (
        typeof value === 'object' &&
        value !== null &&
        'origin' in value &&
        (value.origin === 'synthetic' || value.origin === 'synthetic_fixture')
      );
    } catch {
      return false;
    }
  });
}

export function evaluationLineageFingerprint(
  records: readonly ReductionProgrammeRecord[],
  registrationId?: string,
): string {
  return contractHash(
    records.filter(({ id, record }) => {
      if (record.kind === 'pilot_registration')
        return !registrationId || id === registrationId;
      return (
        (record.kind === 'pilot_amendment' ||
          record.kind === 'digital_action' ||
          record.kind === 'pilot_deviation' ||
          record.kind === 'delivery_verification') &&
        (!registrationId ||
          record.registration_id === registrationId ||
          record.registration_id === null)
      );
    }),
  );
}

export function evaluationSelectedReferences(
  snapshot: ReductionProgrammeSnapshot,
  records: readonly ReductionProgrammeRecord[],
  host: ProgrammeHost,
  identity: TaskIdentity,
): ArtifactRef[] {
  if (!snapshot.evaluation_input_ref)
    throw new TaskError(
      409,
      'programme_evaluation_input_required',
      'Select an exact external evaluation input before starting evaluation.',
    );
  const source = host.readArtifact(snapshot.evaluation_input_ref, identity);
  const input = (() => {
    try {
      return externalEvaluationInputSchema.parse(evaluationContent(source));
    } catch {
      throw new TaskError(
        422,
        'programme_evaluation_input_invalid',
        'The selected source must contain the versioned external-evaluation input JSON contract.',
      );
    }
  })();
  if (input.programme_id !== snapshot.id)
    throw new TaskError(
      409,
      'programme_evaluation_identity',
      'Evaluation input belongs to a different programme.',
    );
  const refs = [
    snapshot.evaluation_input_ref,
    ...evaluationInputEvidenceReferences(input),
  ];
  if (snapshot.evaluation_dossier_ref) {
    const dossierSource = host.readArtifact(
      snapshot.evaluation_dossier_ref,
      identity,
    );
    const dossier = (() => {
      try {
        return scientificQualificationDossierSchema.parse(
          evaluationContent(dossierSource),
        );
      } catch {
        throw new TaskError(
          422,
          'programme_evaluation_dossier_invalid',
          'The selected source must contain the versioned scientific-qualification dossier JSON contract.',
        );
      }
    })();
    refs.push(
      snapshot.evaluation_dossier_ref,
      ...evaluationDossierEvidenceReferences(dossier),
    );
  }
  for (const stored of records) {
    const record = stored.record;
    if (
      stored.id === input.protocol.registration_id ||
      ((record.kind === 'pilot_amendment' ||
        record.kind === 'digital_action' ||
        record.kind === 'pilot_deviation' ||
        record.kind === 'delivery_verification') &&
        (record.registration_id === input.protocol.registration_id ||
          record.registration_id === null))
    )
      refs.push(...embeddedEvaluationReferences(record));
  }
  return [...new Map(refs.map((ref) => [key(ref), ref])).values()];
}

/** Resolve current retained programme facts, including all later delivery events. */
export function deriveEvaluationMethodContext(
  snapshot: ReductionProgrammeSnapshot,
  records: ReductionProgrammeRecord[],
  base: ReductionProgrammeView,
  host: ProgrammeHost,
  identity: TaskIdentity,
  inputRef: ArtifactRef,
  dossierRef: ArtifactRef | null,
  registrationId: string,
): EvaluationMethodContext {
  const input = externalEvaluationInputSchema.parse(
    evaluationContent(host.readArtifact(inputRef, identity)),
  );
  const target = snapshot.preview.selection.target;
  const reasons: string[] = [];
  if (!snapshot.scientific_owner)
    reasons.push(
      'A named programme scientific owner is required for operational scientific adoption.',
    );
  if (
    Date.parse(`${target.scope.period.end}T00:00:00Z`) + 86_400_000 >
    Date.now()
  )
    reasons.push(
      'The registered observation period has not ended; a forecast or incomplete future window cannot establish achieved programme reduction.',
    );
  const context = buildPilotRecordContext(host, identity, base.attempts);
  const registration = records.find(
    (x) => x.id === registrationId && x.record.kind === 'pilot_registration',
  );
  if (!registration || registration.record.kind !== 'pilot_registration')
    throw new TaskError(
      409,
      'programme_registration_required',
      'Evaluation must select its exact retained programme registration.',
    );
  if (
    input.programme_id !== snapshot.id ||
    input.protocol.registration_id !== registrationId
  )
    throw new TaskError(
      409,
      'programme_evaluation_identity',
      'Evaluation input does not bind this programme and selected registration.',
    );
  const amendments = records.filter(
    (x) =>
      x.record.kind === 'pilot_amendment' &&
      x.record.registration_id === registrationId,
  );
  const protocolOptions = [
    registration.record.protocol_ref,
    ...amendments.flatMap((x) =>
      x.record.kind === 'pilot_amendment'
        ? [x.record.amended_protocol_ref]
        : [],
    ),
  ];
  const selectedIndex = protocolOptions.findIndex(
    (ref) => key(ref) === key(input.protocol.protocol_ref),
  );
  if (selectedIndex < 0)
    throw new TaskError(
      409,
      'programme_protocol_required',
      'Evaluation protocol is not an exact retained original or amended registered version.',
    );
  const selectedProtocol = pilotProtocolSchema.parse(
    evaluationContent(host.readArtifact(input.protocol.protocol_ref, identity)),
  );
  const originalRecords = records.filter(
    (x) => !amendments.some((a) => a.id === x.id),
  );
  const originalProtocol = pilotProtocolSchema.parse(
    evaluationContent(
      host.readArtifact(registration.record.protocol_ref, identity),
    ),
  );
  const original = projectPilotRecords(
    { ...snapshot, pilot_input_ref: originalProtocol.input_ref },
    originalRecords,
    {
      ...context,
      current_draft: null,
    },
  );
  const originalRegistration = original.registrations.find(
    (x) => x.record_id === registrationId,
  );
  if (!originalRegistration || originalRegistration.currency !== 'current')
    reasons.push(
      'The original registered protocol or its current upstream support is stale or unavailable.',
    );
  if (
    !originalRegistration ||
    ![
      'attested_before_outcomes',
      'external_prior_registration_attested',
    ].includes(originalRegistration.timing)
  )
    reasons.push(
      'Registration timing or prior outcome access is unknown or outcome-aware; registered-target prespecification is not established.',
    );
  const analysisBasis =
    selectedIndex === 0 ? 'original_registered' : input.protocol.analysis_basis;
  if (selectedIndex > 0) {
    const selectedAmendments = amendments.slice(0, selectedIndex);
    const statuses =
      base.pilot?.amendments.filter((x) =>
        selectedAmendments.some((a) => a.id === x.record_id),
      ) ?? [];
    if (
      analysisBasis !== 'prospectively_amended' ||
      statuses.length !== selectedAmendments.length ||
      statuses.some((x) => x.status !== 'prospective_amendment_attested')
    )
      reasons.push(
        'The selected amended analysis is exploratory, stale, or lacks prospective amendment timing.',
      );
  }
  if (input.protocol.analysis_basis !== analysisBasis)
    reasons.push(
      'Declared analysis basis differs from the retained protocol version.',
    );
  if (
    selectedProtocol.target_sha256 !== contractHash(target) ||
    selectedProtocol.scope_sha256 !== contractHash(target.scope)
  )
    reasons.push(
      'The current target or scope differs from the selected registered protocol; a changed target cannot inherit prespecification.',
    );
  // Interpret each action under its retained rule version. Keep later action
  // events and simulation/unknown latches when reconstructing older protocols.
  const factual = new Map<
    string,
    NonNullable<ReductionProgrammeView['pilot']>['actions'][number]
  >();
  const verifiedCoverage = new Map<string, Set<string>>();
  for (let index = 0; index < protocolOptions.length; index++) {
    const protocol = pilotProtocolSchema.parse(
      evaluationContent(host.readArtifact(protocolOptions[index]!, identity)),
    );
    const visible = records.filter(
      (x) => !amendments.slice(index).some((a) => a.id === x.id),
    );
    const projected = projectPilotRecords(
      { ...snapshot, pilot_input_ref: protocol.input_ref },
      visible,
      {
        ...context,
        current_draft: null,
        current_lineage: {
          selection_ref: protocol.selection_ref,
          assessment_ref: protocol.assessment_ref,
          plan_ref: protocol.plan_ref,
          plan_review_ref: protocol.plan_review_ref,
        },
      },
    );
    for (const action of projected.actions)
      if (action.recorded_delivery) factual.set(action.record_id, action);
    for (const verification of projected.verifications)
      if (verification.status === 'verified') {
        const covered =
          verifiedCoverage.get(verification.record_id) ?? new Set<string>();
        for (const id of verification.covered_action_record_ids)
          if (
            projected.actions.some(
              (action) => action.record_id === id && action.recorded_delivery,
            )
          )
            covered.add(id);
        verifiedCoverage.set(verification.record_id, covered);
      }
  }
  const selectedActions = input.delivery.action_record_ids.map((id) =>
    records.find((x) => x.id === id),
  );
  for (const action of selectedActions)
    if (
      !action ||
      action.record.kind !== 'digital_action' ||
      action.record.registration_id !== registrationId
    )
      reasons.push(
        'An evaluated action is missing or belongs to a different programme registration.',
      );
  if (!selectedActions.length)
    reasons.push('No actual service delivery is selected for this evaluation.');
  const confirmed = input.delivery.action_record_ids.filter((id) =>
    factual.has(id),
  );
  if (confirmed.length !== selectedActions.length)
    reasons.push(
      'Selected delivery is simulated, unconfirmed, stale or unavailable; actual programme delivery is not established.',
    );
  const relevantDeviations = records.filter(
    (x) =>
      x.record.kind === 'pilot_deviation' &&
      (x.record.registration_id === registrationId ||
        x.record.registration_id === null),
  );
  const deviations = relevantDeviations.map((x) => x.id);
  const unresolved =
    base.pilot?.deviations
      .filter(
        (x) => x.material && x.unresolved && deviations.includes(x.record_id),
      )
      .map((x) => x.record_id) ?? [];
  if (unresolved.length)
    reasons.push('Material delivery deviations remain unresolved.');
  if (
    !same(
      [...input.delivery.accounted_deviation_record_ids].sort(),
      [...deviations].sort(),
    )
  )
    reasons.push(
      'The evaluation does not account for every retained relevant delivery deviation.',
    );
  const verifications = input.delivery.verification_record_ids.filter((id) =>
    records.some(
      (x) =>
        x.id === id &&
        x.record.kind === 'delivery_verification' &&
        x.record.registration_id === registrationId,
    ),
  );
  if (verifications.length !== input.delivery.verification_record_ids.length)
    reasons.push(
      'A selected delivery verification does not belong to this registration.',
    );
  if (
    input.design.requires_independent_delivery_verification &&
    input.delivery.action_record_ids.some(
      (id) =>
        !verifications.some((verificationId) =>
          verifiedCoverage.get(verificationId)?.has(id),
        ),
    )
  )
    reasons.push(
      'The declared design requires exact independent delivery verification for all evaluated actions.',
    );
  const rules = selectedActions.flatMap((x) =>
    x?.record.kind === 'digital_action' ? [x.record.rule] : [],
  );
  const refs = evaluationSelectedReferences(
    {
      ...snapshot,
      evaluation_input_ref: inputRef,
      evaluation_dossier_ref: dossierRef,
    },
    records,
    host,
    identity,
  );
  const evidence = collectEvaluationEvidence(refs, host, identity);
  return {
    programme_id: snapshot.id,
    input_ref: inputRef,
    dossier_ref: dossierRef,
    target,
    target_sha256: contractHash(target),
    scope_sha256: contractHash(target.scope),
    registration_id: registrationId,
    protocol_ref: input.protocol.protocol_ref,
    analysis_basis: analysisBasis,
    amendment_record_ids: amendments.map((x) => x.id),
    delivery: {
      action_record_ids: input.delivery.action_record_ids,
      confirmed_action_record_ids: confirmed,
      deviation_record_ids: deviations,
      unresolved_material_deviation_record_ids: unresolved,
      verification_record_ids: verifications,
      rules: [
        ...new Map(rules.map((x) => [`${x.id}:${x.version}`, x])).values(),
      ],
    },
    evidence,
    supporting_refs: evidence.map(({ id, version, sha256 }) => ({
      id,
      version,
      sha256,
    })),
    gate_reasons: unique(reasons),
    expectedScientificOwner: snapshot.scientific_owner,
  };
}

export function validateEvaluationRecord(
  record: EvaluationRecordBody,
  records: ReductionProgrammeRecord[],
  view: ReductionProgrammeView,
  host: ProgrammeHost,
  identity: TaskIdentity,
) {
  const latest = view.attempts.findLast(
    (x) => x.attempt.phase === 'evaluation',
  );
  const current = view.evaluation
    ? view.evaluation.current
    : latest?.currency === 'current'
      ? latest.evaluation
      : null;
  const retained = view.attempts.some(
    (x) =>
      x.attempt.phase === 'evaluation' &&
      x.historical_artifact_refs.some(
        (ref) => key(ref) === key(record.result_ref),
      ),
  );
  const exactCurrent =
    current?.result && key(current.result.artifact) === key(record.result_ref);
  const historicalResolution =
    record.kind === 'evaluation_objection' &&
    record.status === 'resolved' &&
    retained;
  if (
    !exactCurrent &&
    !historicalResolution &&
    !(
      record.kind === 'evaluation_qualification' &&
      record.decision === 'withdrawn' &&
      retained
    )
  )
    throw new TaskError(
      409,
      'programme_evaluation_attempt_required',
      'Evaluation records must bind the exact programme-admitted evaluation result; withdrawal or exact objection resolution may bind a retained historical result.',
    );
  if (record.kind === 'evaluation_qualification') {
    if (Date.parse(record.attested_at) > Date.now())
      throw new TaskError(
        409,
        'evaluation_attestation_future',
        'Adoption cannot attest to a future review.',
      );
    const prior = records.findLast(
      (x) =>
        x.record.kind === 'evaluation_qualification' &&
        key(x.record.result_ref) === key(record.result_ref),
    );
    const latest = records.findLast(
      (x) => x.record.kind === 'evaluation_qualification',
    );
    const withdrawn = records.findLast(
      (x) =>
        x.record.kind === 'evaluation_qualification' &&
        x.record.decision === 'withdrawn',
    );
    const expectedPrior =
      prior?.id ??
      (record.decision !== 'withdrawn' &&
      latest?.record.kind === 'evaluation_qualification' &&
      latest.record.decision === 'withdrawn'
        ? latest.id
        : null);
    if (expectedPrior !== record.supersedes_record_id)
      throw new TaskError(
        409,
        'evaluation_supersession_required',
        'Explicitly supersede the exact latest qualification record or withdrawal requiring a fresh reviewed evaluation.',
      );
    if (record.decision === 'withdrawn' && !prior)
      throw new TaskError(
        409,
        'evaluation_withdrawal_requires_adoption',
        'Withdrawal must identify a retained prior scientific-adoption record for the same result.',
      );
    if (
      record.decision !== 'withdrawn' &&
      withdrawn?.record.kind === 'evaluation_qualification' &&
      (key(withdrawn.record.result_ref) === key(record.result_ref) ||
        key(withdrawn.record.technical_review_ref) ===
          key(record.technical_review_ref) ||
        key(withdrawn.record.dossier_ref) === key(record.dossier_ref))
    )
      throw new TaskError(
        409,
        'evaluation_fresh_review_required',
        'A withdrawn result requires a fresh programme-admitted evaluation, independent review and dossier before new adoption.',
      );
    if (
      record.decision !== 'withdrawn' &&
      (!current?.review ||
        key(current.review.artifact) !== key(record.technical_review_ref) ||
        !current.result?.value.dossier_ref ||
        key(current.result.value.dossier_ref) !== key(record.dossier_ref))
    )
      throw new TaskError(
        409,
        'evaluation_adoption_binding',
        'Adoption must bind the exact current result, independent technical review and selected scientific dossier.',
      );
    if (
      record.decision === 'withdrawn' &&
      prior?.record.kind === 'evaluation_qualification' &&
      (key(prior.record.dossier_ref) !== key(record.dossier_ref) ||
        key(prior.record.technical_review_ref) !==
          key(record.technical_review_ref))
    )
      throw new TaskError(
        409,
        'evaluation_withdrawal_binding',
        'Withdrawal must retain the adopted exact dossier and review.',
      );
    if (record.decision !== 'withdrawn' && withdrawn) {
      const products = [
        record.result_ref,
        record.technical_review_ref,
        record.dossier_ref,
      ].map((reference) => {
        const artifact = host.readArtifact(reference, identity);
        if (
          key(artifact) !== key(reference) ||
          contractHash(artifact.content) !== reference.sha256
        )
          throw new TaskError(
            409,
            'evaluation_fresh_review_required',
            'Fresh review evidence must retain its exact original hash.',
          );
        return artifact;
      });
      const dossier = scientificQualificationDossierSchema.safeParse(
        evaluationContent(products[2]!),
      );
      const withdrawnAt = Date.parse(withdrawn.created_at);
      const attestations = [
        products[0]!.created_at,
        products[1]!.created_at,
        ...(dossier.success ? [dossier.data.reviewer.reviewed_at] : []),
      ];
      if (
        !dossier.success ||
        attestations.some(
          (value) =>
            !Number.isFinite(Date.parse(value)) ||
            Date.parse(value) < withdrawnAt,
        )
      )
        throw new TaskError(
          409,
          'evaluation_fresh_review_required',
          'Requalification requires evaluation products and a scientific review attested after the retained withdrawal; copying old dossier bytes under a new ID is insufficient.',
        );
    }
  } else {
    if (record.status === 'resolved') {
      const original = records.find((x) => x.id === record.resolves_record_id);
      if (
        !original ||
        original.record.kind !== 'evaluation_objection' ||
        original.record.status !== 'open' ||
        original.record.severity !== record.severity ||
        key(original.record.result_ref) !== key(record.result_ref) ||
        !record.evidence.length
      )
        throw new TaskError(
          409,
          'evaluation_objection_resolution',
          'Resolve the exact original objection with retained supporting evidence and unchanged severity.',
        );
    } else if (record.resolves_record_id)
      throw new TaskError(
        409,
        'evaluation_objection_resolution',
        'An open objection cannot resolve another record.',
      );
    for (const ref of record.evidence)
      host.assertEvidenceCurrent(ref, identity);
  }
}

/** Rebuilt on every use: imported flags and old adoption never bypass current gates. */
export function projectEvaluationRecords(
  snapshot: ReductionProgrammeSnapshot,
  records: ReductionProgrammeRecord[],
  base: ReductionProgrammeView,
  host: ProgrammeHost,
  identity: TaskIdentity,
): ProgrammeEvaluationProjection {
  const latest = base.attempts.findLast(
    (x) => x.attempt.phase === 'evaluation',
  );
  const current =
    latest?.currency === 'current' ? (latest.evaluation ?? null) : null;
  const result = current?.result;
  const relevant = records.filter(
    (x) => x.record.kind === 'evaluation_qualification',
  );
  const qualifications: ProgrammeEvaluationProjection['qualifications'] =
    relevant.map((x) => ({
      record_id: x.id,
      decision:
        x.record.kind === 'evaluation_qualification'
          ? x.record.decision
          : 'unqualified',
      currency: 'stale',
      reasons: [],
    }));
  const objections: ProgrammeEvaluationProjection['objections'] = [];
  for (const stored of records) {
    const record = stored.record;
    if (record.kind !== 'evaluation_objection' || record.status !== 'open')
      continue;
    let resolved = false;
    for (const candidate of records) {
      const resolution = candidate.record;
      if (
        resolution.kind !== 'evaluation_objection' ||
        resolution.status !== 'resolved' ||
        resolution.resolves_record_id !== stored.id ||
        resolution.severity !== record.severity ||
        key(resolution.result_ref) !== key(record.result_ref)
      )
        continue;
      try {
        if (!resolution.evidence.length) continue;
        if (
          syntheticProof(
            collectEvaluationEvidence(resolution.evidence, host, identity),
          )
        )
          throw new Error(
            'Synthetic resolution cannot settle scientific objection.',
          );
        resolved = true;
      } catch {
        /* Missing resolution proof cannot clear an immutable objection. */
      }
    }
    objections.push({
      record_id: stored.id,
      unresolved: !resolved,
      material: record.severity === 'material',
      reasons: resolved
        ? []
        : [
            'The retained objection remains unresolved until its exact supporting resolution is current.',
          ],
    });
  }
  const qualification: ProgrammeEvaluationProjection['qualification'] = {
    status: 'unqualified',
    record_id: null,
    dossier_ref: null,
    adopted_by: null,
    human_attestation: true,
    reasons: [],
  };
  const reasons: string[] = [];
  if (
    !result ||
    !current?.review ||
    !['current', 'evidence_gap'].includes(current.state)
  )
    reasons.push(
      'A current programme-admitted evaluation and independent technical review are required.',
    );
  const selectedResult =
    result?.artifact ?? latest?.evaluation?.result?.artifact;
  const adoption = relevant.findLast(
    (x) =>
      x.record.kind === 'evaluation_qualification' &&
      selectedResult &&
      key(x.record.result_ref) === key(selectedResult),
  );
  if (adoption?.record.kind === 'evaluation_qualification') {
    const record = adoption.record;
    qualification.record_id = adoption.id;
    qualification.dossier_ref = record.dossier_ref;
    qualification.adopted_by = record.adopted_by;
    if (record.decision === 'withdrawn') {
      qualification.status = 'withdrawn';
      qualification.reasons.push(
        'The latest human scientific adoption was explicitly withdrawn.',
      );
    } else {
      let supportCurrent = false;
      try {
        validateEvaluationRecord(
          record,
          records.slice(
            0,
            records.findIndex((x) => x.id === adoption.id),
          ),
          base,
          host,
          identity,
        );
        if (
          !result ||
          !current?.review ||
          key(current.review.artifact) !== key(record.technical_review_ref) ||
          !result.value.dossier_ref ||
          key(result.value.dossier_ref) !== key(record.dossier_ref)
        )
          throw new Error(
            'Adoption does not bind the current exact result/review/dossier.',
          );
        host.assertEvidenceCurrent(record.result_ref, identity);
        host.assertEvidenceCurrent(record.technical_review_ref, identity);
        host.assertEvidenceCurrent(record.dossier_ref, identity);
        const input = externalEvaluationInputSchema.parse(
          evaluationContent(
            host.readArtifact(result.value.input_ref, identity),
          ),
        );
        const context = deriveEvaluationMethodContext(
          snapshot,
          records,
          base,
          host,
          identity,
          result.value.input_ref,
          record.dossier_ref,
          result.value.protocol.registration_id,
        );
        const checked = inspectEvaluationDossier(input, context);
        supportCurrent = true;
        qualification.reasons.push(
          ...checked.reasons,
          ...(context.gate_reasons ?? []),
        );
        if (current.review.value.verdict !== 'supported')
          qualification.reasons.push(
            'Independent technical review does not support this exact evaluation.',
          );
        if (result.value.origin !== 'supplied')
          qualification.reasons.push(
            'Synthetic or unknown evidence cannot qualify an actual programme result.',
          );
        if (objections.some((x) => x.material && x.unresolved))
          qualification.reasons.push(
            'An unresolved material evaluation objection blocks unconditional scientific adoption.',
          );
        qualification.status =
          record.decision === 'qualified' &&
          checked.status === 'complete' &&
          qualification.reasons.length === 0
            ? 'qualified'
            : record.decision === 'unqualified'
              ? 'unqualified'
              : 'conditional';
      } catch (error) {
        qualification.reasons.push(
          error instanceof Error
            ? error.message
            : 'Qualification support is unavailable.',
        );
      }
      const projected = qualifications.find(
        (x) => x.record_id === adoption.id,
      )!;
      projected.currency = supportCurrent ? 'current' : 'stale';
    }
    const index = qualifications.find((x) => x.record_id === adoption.id)!;
    if (qualification.status === 'withdrawn') index.currency = 'current';
    index.reasons = unique(qualification.reasons);
    for (const earlier of relevant)
      if (
        earlier.id !== adoption.id &&
        earlier.record.kind === 'evaluation_qualification' &&
        key(earlier.record.result_ref) === key(record.result_ref)
      )
        qualifications.find((x) => x.record_id === earlier.id)!.currency =
          'superseded';
  } else
    qualification.reasons.push(
      'Explicit local human scientific adoption of the reviewed dossier is required.',
    );
  reasons.push(...qualification.reasons);
  if (result?.value.status !== 'supported')
    reasons.push(
      ...(result?.value.reasons ?? ['Evaluation evidence is insufficient.']),
    );
  const point =
    result?.value.target_met === true
      ? 'meets'
      : result?.value.target_met === false
        ? 'below'
        : 'unavailable';
  const qualified =
    qualification.status === 'qualified' &&
    result?.value.status === 'supported' &&
    current?.review?.value.verdict === 'supported';
  const eligible = Boolean(qualified && point === 'meets' && !reasons.length);
  return programmeEvaluationProjectionSchema.parse({
    current,
    qualification: {
      ...qualification,
      reasons: unique(qualification.reasons).slice(0, 64),
    },
    claim: {
      eligible,
      label: eligible
        ? 'external_evaluation_supports_registered_target'
        : point === 'meets'
          ? 'point_estimate_meets_target'
          : point === 'below'
            ? 'point_estimate_below_target'
            : 'insufficient_evidence',
      point_estimate: point,
      reasons: unique(reasons).slice(0, 64),
      reproduction_limits: EVALUATION_LIMITATIONS,
    },
    qualifications,
    objections,
    reasons: unique(reasons).slice(0, 64),
    operational_release: qualified
      ? 'qualified_reference_trace_supported'
      : 'gated_pending_non_synthetic_trace',
    achieved_reduction: eligible,
  });
}
