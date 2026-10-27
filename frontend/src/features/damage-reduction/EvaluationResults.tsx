import type { ArtifactRef } from '../../../../app/contracts/artifacts.ts';
import type { EvaluationTaskView } from '../../../../app/contracts/damage-reduction-evaluation.ts';
import type { ReductionProgrammeView } from '../../../../app/contracts/damage-reduction-programme.ts';
import { Badge } from '../../shared/ui/Badge.tsx';
import { ExactSource } from './ReductionResults.tsx';
import styles from './DamageReductionPage.module.css';

const label = (value: string) => value.replaceAll('_', ' ');
const Reasons = ({ values }: { values: readonly string[] }) =>
  values.length ? (
    <ul>
      {values.map((value, index) => (
        <li key={index}>{value}</li>
      ))}
    </ul>
  ) : null;
function References({
  refs,
  title,
}: {
  refs: readonly ArtifactRef[];
  title: string;
}) {
  return refs.length ? (
    <details>
      <summary>
        {title} ({refs.length})
      </summary>
      {refs.map((ref, index) => (
        <ExactSource
          key={`${ref.id}:${ref.version}:${ref.sha256}:${index}`}
          reference={ref}
          label={`${title} ${index + 1}`}
        />
      ))}
    </details>
  ) : null;
}

export function EvaluationTaskResults({
  view,
  idPrefix = 'evaluation-task',
}: {
  view: EvaluationTaskView;
  idPrefix?: string;
}) {
  const result = view.result?.value,
    review = view.review?.value,
    learning = view.learning?.value;
  const current =
    ['current', 'evidence_gap'].includes(view.state) &&
    review?.verdict === 'supported';
  return (
    <div className={styles.results}>
      <section
        className={styles.card}
        aria-labelledby={`${idPrefix}-comparison-heading`}
      >
        <h3 id={`${idPrefix}-comparison-heading`}>
          {current
            ? 'Reviewed external comparison'
            : 'Retained external comparison'}
        </h3>
        <p>
          <Badge tone={current ? 'info' : 'warn'}>{label(view.state)}</Badge>{' '}
          Execution completion and technical review are separate from scientific
          qualification and the programme claim.
        </p>
        <Reasons values={view.reasons} />
        {result ? (
          <>
            <p>
              Origin: <strong>{result.origin}</strong>. Technical result:{' '}
              {result.status}.{' '}
              {result.origin === 'synthetic' && (
                <strong>
                  Synthetic engineering evidence cannot support operational
                  release or an achieved-effect conclusion.
                </strong>
              )}
            </p>
            <dl className={styles.facts}>
              <div>
                <dt>External source method</dt>
                <dd>
                  {result.source_method.id} · version{' '}
                  {result.source_method.version}
                </dd>
              </div>
              <div>
                <dt>External design</dt>
                <dd>
                  {result.design.id} · version {result.design.version};{' '}
                  {label(result.design.identification)}
                </dd>
              </div>
              <div>
                <dt>Registered analysis/design</dt>
                <dd>{result.design.registered_name}</dd>
              </div>
              <div>
                <dt>Evaluation analysis basis</dt>
                <dd>{label(result.protocol.analysis_basis)}</dd>
              </div>
              <div>
                <dt>Design requires independent delivery verification</dt>
                <dd>
                  {result.design.requires_independent_delivery_verification
                    ? 'Required by this design'
                    : 'Not declared as required by this design'}
                </dd>
              </div>
              <div>
                <dt>Haze comparison method</dt>
                <dd>
                  {result.method_id} · version {result.method_version}
                </dd>
              </div>
              <div>
                <dt>Endpoint and unit</dt>
                <dd>
                  {result.scope.endpoint} · {result.scope.unit}
                </dd>
              </div>
              <div>
                <dt>Population and geography</dt>
                <dd>
                  {result.scope.population} · {result.scope.geography}
                </dd>
              </div>
              <div>
                <dt>Observation period</dt>
                <dd>
                  {result.scope.period.start} to {result.scope.period.end}
                </dd>
              </div>
              <div>
                <dt>Registered target criterion</dt>
                <dd>
                  {label(result.registered_target.relation)} fraction{' '}
                  {result.registered_target.fraction};{' '}
                  {label(result.criterion.kind)}
                </dd>
              </div>
            </dl>
            <p>{result.design.description}</p>
            <h4>External design assumptions</h4>
            <Reasons values={result.design.assumptions} />
            <p>Criterion interpretation: {result.criterion.interpretation}</p>
            <p>
              Uncertainty interpretation: {result.uncertainty_interpretation}
            </p>
            {result.criterion.kind !== 'point_estimate' && (
              <p className={styles.notice}>
                This first comparison path does not support an uncertainty-bound
                or probability criterion. Its required interpretation remains a
                gap; a point estimate does not substitute for it.
              </p>
            )}
            <h4>Dependence assumptions</h4>
            <Reasons values={result.criterion.dependence_assumptions} />
            <dl className={styles.facts}>
              <div>
                <dt>Supplied baseline / intervention estimates</dt>
                <dd>
                  {result.original_estimates.baseline ?? 'Unavailable'} /{' '}
                  {result.original_estimates.intervention ?? 'Unavailable'}
                </dd>
              </div>
              <div>
                <dt>Checked baseline / intervention</dt>
                <dd>
                  {result.baseline_damage ?? 'Unavailable'} /{' '}
                  {result.intervention_damage ?? 'Unavailable'}
                </dd>
              </div>
              <div>
                <dt>Exact absolute reduction</dt>
                <dd>{result.absolute_reduction ?? 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Exact relative reduction ratio</dt>
                <dd>
                  {result.relative_reduction
                    ? `${result.relative_reduction.numerator} / ${result.relative_reduction.denominator}`
                    : 'Unavailable'}
                </dd>
              </div>
            </dl>
            <p className={styles.note}>
              These are external comparative quantities and bounded technical
              checks. No internal causal estimator, exposure-to-damage model or
              uncertainty reconstruction is implied.
            </p>
            <h4>Scope, coverage and missingness</h4>
            <p>
              Pollutant: {result.scope.pollutant}. Coverage:{' '}
              {result.scope.coverage}. Missingness: {result.scope.missingness}.
            </p>
            <Reasons values={result.scope.exclusions} />
            <h4>What Haze reproduced</h4>
            <Reasons values={result.reproduced} />
            <h4>What Haze inspected</h4>
            <Reasons values={result.inspected} />
            <h4>What remains externally calculated</h4>
            <Reasons values={result.externally_calculated} />
            <h4>Gaps and material limitations</h4>
            <Reasons
              values={[
                ...result.reasons,
                ...result.material_limitations,
                ...result.limitations,
              ]}
            />
            <details>
              <summary>Exact protocol, rules and delivery lineage</summary>
              <p className={styles.identifier}>
                Registration {result.protocol.registration_id}. Amendment
                records:{' '}
                {result.protocol.amendment_record_ids.join(', ') || 'none'}.
              </p>
              <ExactSource
                reference={result.protocol.protocol_ref}
                label="Exact evaluated registered protocol"
              />
              <p>
                Rule versions:{' '}
                {result.delivery.rules
                  .map((rule) => `${rule.id} · ${rule.version}`)
                  .join('; ') || 'none supplied'}
                .
              </p>
              <p className={styles.identifier}>
                Action records:{' '}
                {result.delivery.action_record_ids.join(', ') || 'none'}.
              </p>
              <p className={styles.identifier}>
                Deviation records:{' '}
                {result.delivery.deviation_record_ids.join(', ') || 'none'}.
                Accounted departures:{' '}
                {result.delivery.accounted_deviation_record_ids.join(', ') ||
                  'none'}
                .
              </p>
              <p className={styles.identifier}>
                Independent delivery-verification records:{' '}
                {result.delivery.verification_record_ids.join(', ') || 'none'}.
              </p>
              <a href="#programme-delivery-heading">
                Inspect programme delivery, receipts and deviations
              </a>
            </details>
            <ExactSource
              reference={result.input_ref}
              label="Original structured external evaluation and report/data/review references"
            />
            {result.dossier_ref && (
              <ExactSource
                reference={result.dossier_ref}
                label="Exact scientific applicability and independent-review dossier"
              />
            )}
          </>
        ) : (
          <p>
            No retained external result is available. Insufficient evidence is a
            valid completion; missing inputs are never synthesized.
          </p>
        )}
        {view.result && (
          <ExactSource
            reference={view.result.artifact}
            label="Exact checked external evaluation result"
          />
        )}
        {review && (
          <details>
            <summary>
              Independent technical review: {label(review.verdict)}
            </summary>
            <p>
              This checks exact dependencies, arithmetic and qualification
              completeness. It does not authenticate an external reviewer or
              grant scientific qualification.
            </p>
            <p>
              Dossier completeness: {label(review.qualification_check.status)}.
            </p>
            <Reasons
              values={[
                ...review.findings,
                ...review.qualification_check.reasons,
                ...review.limitations,
              ]}
            />
            <ul>
              {review.checks.map((check) => (
                <li key={check.code}>
                  {check.passed ? 'Passed' : 'Failed'}: {check.detail}
                </li>
              ))}
            </ul>
            <References
              refs={review.reviewed_artifacts}
              title="Exact reviewed products"
            />
          </details>
        )}
        {view.review && (
          <ExactSource
            reference={view.review.artifact}
            label="Exact independent evaluation technical review"
          />
        )}
      </section>
      <section
        className={styles.card}
        aria-labelledby={`${idPrefix}-learning-heading`}
      >
        <h3 id={`${idPrefix}-learning-heading`}>
          {current
            ? 'Current reviewed lessons'
            : 'Retained historical or unsupported lessons'}
        </h3>
        {learning ? (
          <>
            <p>
              Technical outcome: {label(learning.outcome)} · origin{' '}
              {learning.origin}.
            </p>
            <Reasons values={learning.lessons} />
            <h4>Next evidence requirements</h4>
            <Reasons values={learning.next_requirements} />
            <References
              refs={learning.evidence}
              title="Original evidence, external reviews and exact learning dependencies"
            />
            <p className={styles.note}>
              Publication: {label(learning.publication)}. World Model acceptance
              and H-MEM publication require separate integrations.
            </p>
          </>
        ) : (
          <p>No reviewed lessons artifact is retained.</p>
        )}
        {view.learning && (
          <ExactSource
            reference={view.learning.artifact}
            label="Exact retained lessons artifact"
          />
        )}
      </section>
    </div>
  );
}

export function ProgrammeEvaluationResults({
  view,
}: {
  view: ReductionProgrammeView;
}) {
  const projection = view.evaluation;
  if (!projection)
    return (
      <section
        className={styles.card}
        aria-labelledby="programme-evaluation-heading"
      >
        <h2 id="programme-evaluation-heading">Evaluation and learning</h2>
        <p>
          Current evaluation support is unavailable. No conclusion is inferred
          from imported approval flags or an absent server projection.
        </p>
        <p>
          Engineering completion remains separate from operational release and
          scientific readiness.
        </p>
      </section>
    );
  const external =
    projection.claim.eligible &&
    projection.claim.label === 'external_evaluation_supports_registered_target';
  const point = projection.claim.point_estimate;
  return (
    <section
      className={styles.card}
      aria-labelledby="programme-evaluation-heading"
    >
      <h2 id="programme-evaluation-heading">Evaluation and learning</h2>
      <p className={styles.notice}>
        {projection.operational_release ===
        'qualified_reference_trace_supported'
          ? 'The server reports a qualified reference trace for the stated physical method and claim.'
          : 'Operational release: gated pending a complete reviewed non-synthetic reference trace.'}{' '}
        Live execution remains deferred. Scientific review, delivery evidence,
        technical comparison and publication remain separate.
      </p>
      <p>
        <Badge tone={external ? 'info' : 'warn'}>
          {external
            ? 'External evaluation supports the registered target'
            : projection.claim.label ===
                'external_evaluation_supports_registered_target'
              ? 'External target conclusion withheld'
              : label(projection.claim.label)}
        </Badge>
      </p>
      <p>
        {point === 'meets'
          ? 'Point estimate meets target.'
          : point === 'below'
            ? 'Point estimate is below target.'
            : 'Point comparison is unavailable.'}{' '}
        A supported below-target or insufficient-evidence result is valid
        completion.
      </p>
      <Reasons values={[...projection.claim.reasons, ...projection.reasons]} />
      <h3>Scientific qualification and local adoption</h3>
      <p>
        Server qualification: <strong>{projection.qualification.status}</strong>
        . Adopted by:{' '}
        {projection.qualification.adopted_by ?? 'No adoption recorded'}.
      </p>
      <p className={styles.note}>
        Adoption is a retained human attestation. Haze does not authenticate
        external scientific credentials; imported qualification flags do not
        govern this status.
      </p>
      <Reasons values={projection.qualification.reasons} />
      {projection.qualification.dossier_ref && (
        <ExactSource
          reference={projection.qualification.dossier_ref}
          label="Exact adopted or withdrawn scientific dossier"
        />
      )}
      <h3>Reproduction limits</h3>
      <Reasons values={projection.claim.reproduction_limits} />
      <details>
        <summary>Retained qualification decisions and objections</summary>
        {projection.qualifications.map((entry) => {
          const stored = view.records.find(
            (record) => record.id === entry.record_id,
          );
          const body =
            stored?.record.kind === 'evaluation_qualification'
              ? stored.record
              : null;
          return (
            <div key={entry.record_id} className={styles.source}>
              <p>
                {entry.decision} · {entry.currency} · record {entry.record_id}
              </p>
              {body && (
                <>
                  <p>{body.reason}</p>
                  <p>
                    Human adoption by {body.adopted_by} at {body.attested_at};
                    supersedes {body.supersedes_record_id ?? 'none'}.
                  </p>
                  <References
                    refs={[
                      body.result_ref,
                      body.technical_review_ref,
                      body.dossier_ref,
                    ]}
                    title="Exact qualification lineage"
                  />
                </>
              )}
              <Reasons values={entry.reasons} />
            </div>
          );
        })}
        {!projection.qualifications.length && (
          <p>No qualification adoption or withdrawal is recorded.</p>
        )}
        {projection.objections.map((entry) => {
          const stored = view.records.find(
            (record) => record.id === entry.record_id,
          );
          const body =
            stored?.record.kind === 'evaluation_objection'
              ? stored.record
              : null;
          return (
            <div key={entry.record_id} className={styles.source}>
              <p>
                <strong>
                  {entry.unresolved ? 'Unresolved' : 'Resolved'}{' '}
                  {entry.material ? 'material' : 'minor'} objection
                </strong>
              </p>
              {body && (
                <>
                  <p>{body.description}</p>
                  <References
                    refs={[body.result_ref, ...body.evidence]}
                    title="Exact objection support"
                  />
                </>
              )}
              <Reasons values={entry.reasons} />
            </div>
          );
        })}
        {!projection.objections.length && (
          <p>
            No evaluation objections are recorded; absence alone does not
            establish qualified support.
          </p>
        )}
      </details>
      {projection.current ? (
        <EvaluationTaskResults
          view={projection.current}
          idPrefix="programme-current-evaluation"
        />
      ) : (
        <p>
          No current reviewed evaluation task result is available. Historical
          attempts remain below.
        </p>
      )}
    </section>
  );
}
