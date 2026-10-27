import type { ArtifactRef } from '../../../../app/contracts/artifacts.ts';
import type {
  PilotRecordBody,
  PilotTaskView,
} from '../../../../app/contracts/damage-reduction-pilot.ts';
import type { ReductionProgrammeView } from '../../../../app/contracts/damage-reduction-programme.ts';
import { Badge } from '../../shared/ui/Badge.tsx';
import { ExactSource } from './ReductionResults.tsx';
import styles from './DamageReductionPage.module.css';

const label = (value: string) => value.replaceAll('_', ' ');
function Reasons({ values }: { values: readonly string[] }) {
  return values.length ? (
    <ul>
      {values.map((reason, index) => (
        <li key={index}>{reason}</li>
      ))}
    </ul>
  ) : null;
}
function EvidenceRefs({
  references,
  label: title,
}: {
  references: readonly ArtifactRef[];
  label: string;
}) {
  return references.length ? (
    <details>
      <summary>
        {title} ({references.length})
      </summary>
      {references.map((reference, index) => (
        <ExactSource
          key={`${reference.id}:${reference.version}:${reference.sha256}`}
          reference={reference}
          label={`${title} ${index + 1}`}
        />
      ))}
    </details>
  ) : null;
}

export function PilotTaskResults({
  view,
  idPrefix = 'pilot-draft',
}: {
  view: PilotTaskView;
  idPrefix?: string;
}) {
  const feasibility = view.feasibility?.value;
  const protocol = view.protocol?.value;
  const specification = protocol?.specification;
  const rule = specification?.digital_rule;
  const current =
    view.state === 'current' && view.review?.value.verdict === 'supported';
  return (
    <div className={styles.results}>
      <p className={styles.notice}>
        Live execution is deferred. This is a retained pilot draft and review;
        no alert is sent and no work schedule is applied. Scientific
        qualification remains unqualified. Achieved damage reduction is not
        established.
      </p>
      {!current && (
        <p role="status">
          {view.state === 'stale'
            ? 'Historical pilot draft — current applicability is withheld.'
            : 'Current pilot draft support is unavailable or still under review.'}
        </p>
      )}
      <Reasons values={view.reasons} />
      <section
        className={styles.card}
        aria-labelledby={`${idPrefix}-feasibility-heading`}
      >
        <h3 id={`${idPrefix}-feasibility-heading`}>Pilot feasibility</h3>
        {feasibility ? (
          <>
            <p className={styles.resultLabel}>
              <Badge tone={current ? 'info' : 'warn'}>
                {current ? 'Current classification' : 'Retained classification'}
                : {label(feasibility.classification)}
              </Badge>
            </p>
            <p>
              Origin: <strong>{feasibility.origin}</strong>. Basis:{' '}
              {label(feasibility.classification_basis)}. Intended pilot:{' '}
              {label(feasibility.intended_kind)}.
            </p>
            <p className={styles.note}>
              A supplied scientific-review attestation is distinct from Haze's
              arithmetic/consistency review and does not establish an achieved
              effect.
            </p>
            <div className={styles.tableWrap}>
              <table>
                <caption>Supplied design-specific feasibility findings</caption>
                <thead>
                  <tr>
                    <th scope="col">Topic</th>
                    <th scope="col">Status</th>
                    <th scope="col">Finding and exact support</th>
                  </tr>
                </thead>
                <tbody>
                  {feasibility.findings.map((finding) => (
                    <tr key={finding.topic}>
                      <th scope="row">{label(finding.topic)}</th>
                      <td>{finding.status}</td>
                      <td>
                        {finding.statement}
                        <EvidenceRefs
                          references={finding.evidence}
                          label="Finding evidence"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {feasibility.scientific_review && (
              <details>
                <summary>Supplied scientific-review attestation</summary>
                <dl className={styles.facts}>
                  <div>
                    <dt>Reviewer and role</dt>
                    <dd>
                      {feasibility.scientific_review.reviewer} ·{' '}
                      {feasibility.scientific_review.role}
                    </dd>
                  </div>
                  <div>
                    <dt>Independence and conflicts</dt>
                    <dd>
                      {feasibility.scientific_review.independent
                        ? 'Independence attested'
                        : 'Independence not attested'}{' '}
                      · {label(feasibility.scientific_review.conflicts)}
                    </dd>
                  </div>
                  <div>
                    <dt>Supplied decision</dt>
                    <dd>{label(feasibility.scientific_review.decision)}</dd>
                  </div>
                  <div>
                    <dt>Local adoption</dt>
                    <dd>
                      {feasibility.scientific_review.adopted_by ??
                        'Not supplied'}
                    </dd>
                  </div>
                </dl>
                <p>
                  Attested review time:{' '}
                  <time dateTime={feasibility.scientific_review.reviewed_at}>
                    {feasibility.scientific_review.reviewed_at}
                  </time>
                  .
                </p>
                <EvidenceRefs
                  references={feasibility.scientific_review.evidence}
                  label="Scientific review evidence"
                />
              </details>
            )}
            <h4>Missing prerequisites</h4>
            {feasibility.prerequisites.length ? (
              <Reasons values={feasibility.prerequisites} />
            ) : (
              <p>
                No additional completeness prerequisite was recorded. Scientific
                qualification still remains unqualified.
              </p>
            )}
            <details>
              <summary>Supplied assumptions and calculations</summary>
              <Reasons values={feasibility.assumptions} />
              <EvidenceRefs
                references={feasibility.calculations}
                label="Supplied calculations"
              />
            </details>
            <details>
              <summary>Feasibility limitations</summary>
              <Reasons values={feasibility.limitations} />
            </details>
          </>
        ) : (
          <p>
            Feasibility evidence is unavailable. A supplied design and its
            review are required.
          </p>
        )}
        {view.feasibility && (
          <ExactSource
            reference={view.feasibility.artifact}
            label="Exact feasibility artifact"
          />
        )}
      </section>
      <section
        className={styles.card}
        aria-labelledby={`${idPrefix}-protocol-heading`}
      >
        <h3 id={`${idPrefix}-protocol-heading`}>
          Protocol draft and agreed-rule version
        </h3>
        {specification ? (
          <>
            <p>
              <strong>
                {specification.id} · version {specification.version}
              </strong>{' '}
              — draft; registration is a separate explicit append.
            </p>
            <dl className={styles.facts}>
              <div>
                <dt>Design</dt>
                <dd>{specification.design_name ?? 'Not supplied'}</dd>
              </div>
              <div>
                <dt>Endpoint and unit</dt>
                <dd>
                  {specification.primary_endpoint ?? 'Not supplied'} ·{' '}
                  {specification.unit ?? 'Not supplied'}
                </dd>
              </div>
              <div>
                <dt>Population</dt>
                <dd>{specification.population ?? 'Not supplied'}</dd>
              </div>
              <div>
                <dt>Ordinary-management comparator</dt>
                <dd>{specification.comparator ?? 'Not supplied'}</dd>
              </div>
              <div>
                <dt>Observation window</dt>
                <dd>
                  {specification.observation_window
                    ? `${specification.observation_window.start} to ${specification.observation_window.end}`
                    : 'Not supplied'}
                </dd>
              </div>
              <div>
                <dt>Target criterion</dt>
                <dd>
                  {specification.target_rule
                    ? `${label(specification.target_rule.relation)} fraction ${specification.target_rule.fraction}; ${label(specification.target_rule.assessment_rule)}`
                    : 'Not supplied'}
                </dd>
              </div>
            </dl>
            {specification.analysis_method && (
              <>
                <h4>Registered analysis proposed for review</h4>
                <p>
                  {specification.analysis_method.id} ·{' '}
                  {specification.analysis_method.version}:{' '}
                  {specification.analysis_method.description}
                </p>
                <p>
                  Uncertainty rule:{' '}
                  {label(specification.analysis_method.uncertainty_rule)}.{' '}
                  {specification.analysis_method.interpretation}
                </p>
              </>
            )}
            <dl className={styles.facts}>
              <div>
                <dt>Missingness rule</dt>
                <dd>{specification.missingness_rule ?? 'Not supplied'}</dd>
              </div>
              <div>
                <dt>Deviation rule</dt>
                <dd>{specification.deviation_rule ?? 'Not supplied'}</dd>
              </div>
            </dl>
            <h4>Stopping criteria</h4>
            <Reasons values={specification.stopping_criteria} />
            <h4>Delivery checks</h4>
            <Reasons values={specification.delivery_checks} />
            {rule ? (
              <>
                <h4>
                  Digital rule {rule.id} · version {rule.version}
                </h4>
                <dl className={styles.facts}>
                  <div>
                    <dt>Action and owner</dt>
                    <dd>
                      {label(rule.kind)} · {rule.owner ?? 'Owner not supplied'}
                    </dd>
                  </div>
                  <div>
                    <dt>Human approval</dt>
                    <dd>
                      {rule.approval.status};{' '}
                      {rule.approval.approver ?? 'approver not supplied'};
                      approval time{' '}
                      {rule.approval.approved_at ?? 'not supplied'}
                    </dd>
                  </div>
                  <div>
                    <dt>Trigger rule</dt>
                    <dd>{rule.trigger_rule ?? 'Not supplied'}</dd>
                  </div>
                  <div>
                    <dt>Pause/disable rule</dt>
                    <dd>{rule.pause_disable_rule ?? 'Not supplied'}</dd>
                  </div>
                  <div>
                    <dt>Operating scope</dt>
                    <dd>
                      {rule.scope.geography} · {rule.scope.population} ·{' '}
                      {rule.scope.period.start} to {rule.scope.period.end}
                    </dd>
                  </div>
                  <div>
                    <dt>Recipients / schedules</dt>
                    <dd>
                      {rule.scope.recipient_groups.join(', ') ||
                        'No recipient groups declared'}{' '}
                      /{' '}
                      {rule.scope.schedule_ids.join(', ') ||
                        'No schedules declared'}
                    </dd>
                  </div>
                </dl>
                <h4>Permitted actions</h4>
                <Reasons values={rule.permitted_actions} />
                <h4>Safeguards</h4>
                <Reasons values={rule.safeguards} />
                <EvidenceRefs
                  references={rule.approval.evidence}
                  label="Rule approval evidence"
                />
                {rule.trigger_inputs.map((input) => (
                  <EvidenceRefs
                    key={input.name}
                    references={input.evidence}
                    label={`Trigger input ${input.name}`}
                  />
                ))}
              </>
            ) : (
              <p>
                No digital rule is supplied. Rule ownership, permitted actions,
                scope and human approval remain prerequisites.
              </p>
            )}
            <h4>Protocol prerequisites</h4>
            <Reasons values={protocol.prerequisites} />
            <details>
              <summary>Protocol limitations</summary>
              <Reasons values={protocol.limitations} />
            </details>
          </>
        ) : (
          <p>A protocol draft has not been retained.</p>
        )}
        {view.protocol && (
          <ExactSource
            reference={view.protocol.artifact}
            label="Exact protocol draft"
          />
        )}
        {view.review && (
          <>
            <p>
              Independent deterministic pilot review:{' '}
              {label(view.review.value.verdict)}.
            </p>
            <Reasons values={view.review.value.findings} />
            <ExactSource
              reference={view.review.artifact}
              label="Exact independent pilot review"
            />
          </>
        )}
      </section>
    </div>
  );
}

function recordOfKind<K extends PilotRecordBody['kind']>(
  view: ReductionProgrammeView,
  id: string,
  kind: K,
): Extract<PilotRecordBody, { kind: K }> | null {
  const value = view.records.find((entry) => entry.id === id)?.record;
  return value?.kind === kind
    ? (value as Extract<PilotRecordBody, { kind: K }>)
    : null;
}

export function PilotDeliveryResults({
  view,
}: {
  view: ReductionProgrammeView;
}) {
  const projection = view.pilot;
  if (!projection)
    return (
      <section className={styles.card}>
        <h2 id="programme-pilot-heading">Pilot</h2>
        <p>Current pilot feasibility and records are unavailable.</p>
        <h2 id="programme-delivery-heading">Delivery</h2>
        <p>
          Live execution is deferred. No delivery status is inferred from
          missing records.
        </p>
      </section>
    );
  return (
    <div className={styles.results}>
      <section
        className={styles.card}
        aria-labelledby="programme-pilot-heading"
      >
        <h2 id="programme-pilot-heading">Pilot registration and amendments</h2>
        <p className={styles.notice}>
          Live execution is deferred. Scientific qualification remains
          unqualified. Pilot, delivery and achieved damage reduction remain
          separate.
        </p>
        {projection.feasibility ? (
          <>
            <p>
              {projection.feasibility.current
                ? 'Current feasibility classification'
                : 'Historical feasibility classification'}
              : <strong>{label(projection.feasibility.classification)}</strong>{' '}
              · origin {projection.feasibility.origin}.
            </p>
            <Reasons values={projection.feasibility.prerequisites} />
          </>
        ) : (
          <p>
            Feasibility evidence is unavailable. Select supplied inputs and
            explicitly start a pilot draft from a reviewed planning attempt.
          </p>
        )}
        <Reasons values={projection.reasons} />
        <h3>Immutable registrations</h3>
        {!projection.registrations.length && (
          <p>No protocol is registered. Saving a draft does not register it.</p>
        )}
        {projection.registrations.map((entry) => {
          const body = recordOfKind(
            view,
            entry.record_id,
            'pilot_registration',
          );
          return (
            <div className={styles.source} key={entry.record_id}>
              <p className={styles.identifier}>
                Registration {entry.record_id}
              </p>
              <p>
                <Badge tone={entry.currency === 'current' ? 'info' : 'stale'}>
                  {entry.currency}
                </Badge>{' '}
                Timing: {label(entry.timing)}. Analysis status:{' '}
                {label(entry.analysis_status)}.
              </p>
              <p>
                Haze registration recorded at{' '}
                <time dateTime={entry.recorded_at}>{entry.recorded_at}</time>.
              </p>
              {body && (
                <>
                  <dl className={styles.facts}>
                    <div>
                      <dt>Outcome collection access</dt>
                      <dd>
                        {label(body.outcome_access.collection)}; start{' '}
                        {body.outcome_access.collection_started_at ??
                          'not supplied'}
                      </dd>
                    </div>
                    <div>
                      <dt>Analysis access</dt>
                      <dd>
                        {label(body.outcome_access.analysis)}; start{' '}
                        {body.outcome_access.analysis_started_at ??
                          'not supplied'}
                      </dd>
                    </div>
                    <div>
                      <dt>Timing attestation</dt>
                      <dd>
                        {body.outcome_access.attested_by} ·{' '}
                        {body.outcome_access.attested_at}
                      </dd>
                    </div>
                    <div>
                      <dt>External registration</dt>
                      <dd>
                        {body.external_registration
                          ? `${body.external_registration.registry} · supplied prior time ${body.external_registration.registered_at}`
                          : 'No external registration supplied'}
                      </dd>
                    </div>
                  </dl>
                  <EvidenceRefs
                    references={body.outcome_access.evidence}
                    label="Outcome-access evidence"
                  />
                  <EvidenceRefs
                    references={[body.feasibility_ref, body.review_ref]}
                    label="Original registration feasibility and independent review"
                  />
                  {body.external_registration && (
                    <ExactSource
                      reference={body.external_registration.evidence}
                      label="External registration evidence"
                    />
                  )}
                </>
              )}
              <p className={styles.note}>
                A later import cannot establish earlier prespecification.
                Original and amended analyses remain separate.
              </p>
              <Reasons values={entry.reasons} />
              <ExactSource
                reference={entry.protocol_ref}
                label="Original immutable registered protocol"
              />
              <ExactSource
                reference={entry.effective_protocol_ref}
                label="Effective protocol retained for registration"
              />
            </div>
          );
        })}
        <h3>Protocol amendments</h3>
        {!projection.amendments.length && <p>No amendments are recorded.</p>}
        {projection.amendments.map((entry) => {
          const body = recordOfKind(view, entry.record_id, 'pilot_amendment');
          return (
            <div className={styles.source} key={entry.record_id}>
              <p className={styles.identifier}>
                Amendment {entry.record_id} · registration{' '}
                {entry.registration_id}
              </p>
              <p>
                <Badge
                  tone={
                    entry.status === 'prospective_amendment_attested'
                      ? 'info'
                      : 'warn'
                  }
                >
                  {label(entry.status)}
                </Badge>
              </p>
              {body && (
                <>
                  <p>{body.reason}</p>
                  <p>
                    Affected fields:{' '}
                    {body.affected_fields.map(label).join(', ')}. Outcomes
                    available: {body.outcomes_available}. Attested by{' '}
                    {body.attested_by} at {body.attested_at}.
                  </p>
                  <ExactSource
                    reference={body.amended_protocol_ref}
                    label="Exact amended protocol"
                  />
                  <ExactSource
                    reference={body.review_ref}
                    label="Exact amendment review"
                  />
                </>
              )}
              <Reasons values={entry.reasons} />
              {entry.status === 'exploratory' && (
                <p className={styles.notice}>
                  Exploratory or outcome-aware amendments do not replace the
                  original registered analysis.
                </p>
              )}
            </div>
          );
        })}
      </section>
      <section
        className={styles.card}
        aria-labelledby="programme-delivery-heading"
      >
        <h2 id="programme-delivery-heading">
          Delivery records and verification
        </h2>
        <p className={styles.notice}>
          Live service integration is deferred. This page records simulations or
          imported evidence; it executes no alert or schedule action. No receipt
          alone establishes reduced exposure or damage.
        </p>
        <p className={styles.note}>
          Provider acceptance is a submission-level confirmation. Alert
          transmission, alert receipt and an applied schedule are distinct.
          Receipt does not establish attention or adherence.
        </p>
        {!projection.actions.length && (
          <p>
            No digital-action events are recorded. Missing events do not
            establish delivery.
          </p>
        )}
        {projection.actions.map((entry) => {
          const body = recordOfKind(view, entry.record_id, 'digital_action');
          const simulated =
            entry.origin === 'simulated' ||
            entry.effective_status === 'simulated';
          return (
            <div className={styles.source} key={entry.record_id}>
              <h3>Action {entry.action_id}</h3>
              <p>
                <Badge
                  tone={
                    simulated
                      ? 'warn'
                      : entry.effective_status === 'failed' ||
                          entry.effective_status === 'unknown'
                        ? 'warn'
                        : 'info'
                  }
                >
                  {simulated
                    ? 'Simulated action'
                    : label(entry.effective_status)}
                </Badge>{' '}
                Origin: {label(entry.origin)} · {entry.currency}.
              </p>
              <dl className={styles.facts}>
                <div>
                  <dt>Stated confirmation level</dt>
                  <dd>{label(entry.confirmation_level)}</dd>
                </div>
                <div>
                  <dt>Recorded-delivery support</dt>
                  <dd>
                    {simulated
                      ? 'Simulation only; no live delivery'
                      : entry.currency !== 'current'
                        ? 'Historical event; current support withheld'
                        : entry.recorded_delivery
                          ? 'Server-supported for the stated confirmation only'
                          : 'Not established'}
                  </dd>
                </div>
                <div>
                  <dt>Independent verification</dt>
                  <dd>
                    {entry.currency === 'current' ? '' : 'Historical status: '}
                    {label(entry.independent_verification)}
                  </dd>
                </div>
                <div>
                  <dt>Exact record</dt>
                  <dd className={styles.identifier}>{entry.record_id}</dd>
                </div>
              </dl>
              {body && (
                <>
                  <p>{body.description}</p>
                  <p>
                    Action payload version {body.action_version}; permitted
                    action: {body.permitted_action}.
                  </p>
                  <p>
                    Rule {body.rule.id} · version {body.rule.version};{' '}
                    {label(body.action_kind)}; event time {body.occurred_at}.
                  </p>
                  <p>
                    Scope: {body.scope.geography} · {body.scope.population} ·{' '}
                    {body.scope.period.start} to {body.scope.period.end}.
                    Recipient groups:{' '}
                    {body.scope.recipient_groups.join(', ') || 'none declared'};
                    schedules:{' '}
                    {body.scope.schedule_ids.join(', ') || 'none declared'}.
                  </p>
                  {body.reconciles_record_id && (
                    <p className={styles.identifier}>
                      Reconciles earlier record {body.reconciles_record_id}; its
                      earlier unknown/failed outcome remains in history.
                    </p>
                  )}
                  <EvidenceRefs
                    references={body.trigger_refs}
                    label="Exact trigger evidence"
                  />
                  {body.receipt_ref ? (
                    <ExactSource
                      reference={body.receipt_ref}
                      label="Exact service receipt"
                    />
                  ) : (
                    <p>No service receipt is attached.</p>
                  )}
                </>
              )}
              <Reasons values={entry.reasons} />
            </div>
          );
        })}
        <h3>Deviations</h3>
        {!projection.deviations.length && (
          <p>
            No deviation records are retained; this does not verify adherence.
          </p>
        )}
        {projection.deviations.map((entry) => {
          const body = recordOfKind(view, entry.record_id, 'pilot_deviation');
          return (
            <div className={styles.source} key={entry.record_id}>
              <p>
                <strong>
                  {entry.unresolved ? 'Unresolved' : 'Resolved'}{' '}
                  {entry.material ? 'material' : 'non-material'} deviation
                </strong>
              </p>
              {body && (
                <>
                  <p>
                    {body.category}: {body.description}
                  </p>
                  <p>
                    Reported status {body.status}; occurred at{' '}
                    {body.occurred_at}.
                  </p>
                  <EvidenceRefs
                    references={body.evidence}
                    label="Deviation evidence"
                  />
                </>
              )}
              <Reasons values={entry.reasons} />
            </div>
          );
        })}
        <h3>Independent delivery-verification records</h3>
        {!projection.verifications.length && (
          <p>No independent delivery verification is recorded.</p>
        )}
        {projection.verifications.map((entry) => {
          const body = recordOfKind(
            view,
            entry.record_id,
            'delivery_verification',
          );
          return (
            <div className={styles.source} key={entry.record_id}>
              <p>
                <Badge tone={entry.status === 'verified' ? 'info' : 'warn'}>
                  {label(entry.status)}
                </Badge>
              </p>
              <p className={styles.identifier}>
                Covered exact action records:{' '}
                {entry.covered_action_record_ids.join(', ') || 'none'}
              </p>
              {body && (
                <ExactSource
                  reference={body.verification_ref}
                  label="Exact independent verification artifact"
                />
              )}
              <Reasons values={entry.reasons} />
            </div>
          );
        })}
        <p className={styles.note}>
          Imported delivery and verification remain subject to source access,
          scope and currency checks. Achieved reduction requires a separate
          qualified evaluation.
        </p>
      </section>
    </div>
  );
}
