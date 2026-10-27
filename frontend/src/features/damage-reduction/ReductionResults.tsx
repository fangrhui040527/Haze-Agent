import { useState } from 'react';
import type {
  Artifact,
  ArtifactRef,
} from '../../../../app/contracts/artifacts.ts';
import type { ReductionPreviewView } from '../../../../app/contracts/damage-reduction-view.ts';
import { agentService } from '../../services/agents/index.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { Badge } from '../../shared/ui/Badge.tsx';
import { readResidualSource } from './preview-input.ts';
import styles from './DamageReductionPage.module.css';

export function ExactSource({
  reference,
  label,
}: {
  reference: ArtifactRef;
  label: string;
}) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  let physicalOrigin: string | null = null;
  if (artifact) {
    try {
      physicalOrigin = readResidualSource(artifact).origin;
    } catch {
      /* Other artifact families retain their transport attribution only. */
    }
  }
  const inspect = async () => {
    setPending(true);
    setError(null);
    setArtifact(null);
    try {
      if (!agentService.readArtifact)
        throw new Error(
          'Exact source inspection is unavailable on this task service.',
        );
      const current = await agentService.readArtifact(reference.id);
      if (
        current.version !== reference.version ||
        current.sha256 !== reference.sha256
      )
        throw new Error(
          'The source does not match its exact selected version and hash.',
        );
      setArtifact(current);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The source is unavailable or inaccessible.',
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <details className={styles.source}>
      <summary>
        {label} · version {reference.version}
      </summary>
      <p className={styles.identifier}>
        ID {reference.id}
        <br />
        SHA-256 {reference.sha256}
      </p>
      <Button size="small" onClick={() => void inspect()} disabled={pending}>
        {pending ? 'Checking source access…' : 'Inspect exact source'}
      </Button>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {artifact && (
        <>
          <p>
            {artifact.filename ?? artifact.kind} · Artifact origin:{' '}
            {artifact.evidence_origin ?? 'unspecified'}
          </p>
          {artifact.declared_origin && (
            <p>Declared attribution: {artifact.declared_origin}</p>
          )}
          {physicalOrigin && (
            <p>
              Physical evidence origin: <strong>{physicalOrigin}</strong>.
            </p>
          )}
          <pre className={styles.sourceText}>
            {typeof artifact.content === 'string'
              ? artifact.content
              : JSON.stringify(artifact.content, null, 2)}
          </pre>
        </>
      )}
    </details>
  );
}

export function ReductionResults({
  view,
  idPrefix = 'reduction',
}: {
  view: ReductionPreviewView;
  idPrefix?: string;
}) {
  const selection = view.selection?.value;
  const assessment = view.assessment?.value;
  const plan = view.plan?.value;
  const current = view.state === 'current';
  const arithmeticEligible =
    current && view.claims?.claim_eligibility === 'arithmetic_checked_scenario';
  const planEligible = current && view.plan_eligibility !== 'none';
  const pointLabel =
    arithmeticEligible && view.claims?.point_estimate_label === 'meets'
      ? 'Point estimate meets target'
      : arithmeticEligible &&
          view.claims?.point_estimate_label === 'does_not_meet'
        ? 'Point estimate does not meet target'
        : 'Evidence unavailable for a current target conclusion';
  return (
    <div className={styles.results}>
      {view.state !== 'current' && (
        <p className={styles.notice} role="status">
          {view.state === 'pending'
            ? 'Assessment and planning reviews are still pending.'
            : view.state === 'stale'
              ? 'Historical result — current claim eligibility is withheld. Reassess the corrected evidence before reuse.'
              : 'Evidence unavailable. Current claim eligibility is withheld.'}
        </p>
      )}
      {view.reasons.length > 0 && (
        <ul className={styles.note}>
          {view.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}
      <section
        className={styles.card}
        aria-labelledby={`${idPrefix}-target-heading`}
      >
        <h2 id={`${idPrefix}-target-heading`}>
          <span className={styles.step}>1</span> Target
        </h2>
        {selection ? (
          <>
            <dl className={styles.facts}>
              <div>
                <dt>Physical endpoint</dt>
                <dd>{selection.target.scope.endpoint}</dd>
              </div>
              <div>
                <dt>Target</dt>
                <dd>
                  {selection.target.relation === 'at_least'
                    ? 'At least'
                    : 'Strictly greater than'}{' '}
                  fraction {selection.target.target_fraction} · point estimate
                </dd>
              </div>
              <div>
                <dt>Ordinary management</dt>
                <dd>{selection.target.comparator}</dd>
              </div>
              <div>
                <dt>Digital intervention</dt>
                <dd>{selection.target.intervention}</dd>
              </div>
              <div>
                <dt>Population and place</dt>
                <dd>
                  {selection.target.scope.population} ·{' '}
                  {selection.target.scope.geography}
                </dd>
              </div>
              <div>
                <dt>Period</dt>
                <dd>
                  {selection.target.scope.period.start} to{' '}
                  {selection.target.scope.period.end}
                </dd>
              </div>
              <div>
                <dt>Coverage</dt>
                <dd>{selection.target.scope.coverage}</dd>
              </div>
              <div>
                <dt>Missingness</dt>
                <dd>{selection.target.scope.missingness}</dd>
              </div>
            </dl>
            {!!selection.target.scope.exclusions.length && (
              <p>Exclusions: {selection.target.scope.exclusions.join('; ')}</p>
            )}
          </>
        ) : (
          <p>
            Evidence unavailable: no exact target selection has been retained.
          </p>
        )}
        {view.selection && (
          <ExactSource
            reference={view.selection.artifact}
            label="Exact input selection"
          />
        )}
      </section>
      <section
        className={styles.card}
        aria-labelledby={`${idPrefix}-assessment-heading`}
      >
        <h2 id={`${idPrefix}-assessment-heading`}>
          <span className={styles.step}>2</span> Assessment
        </h2>
        <p className={styles.resultLabel}>
          <Badge tone={arithmeticEligible ? 'info' : 'warn'}>
            {pointLabel}
          </Badge>
        </p>
        {assessment ? (
          <>
            <p>
              <strong>
                Origin:{' '}
                {assessment.origin === 'synthetic'
                  ? 'synthetic engineering evidence'
                  : assessment.origin}
                .
              </strong>{' '}
              Scientific qualification: unqualified.
            </p>
            <p className={styles.note}>
              These are server-calculated supplied scenario quantities. No
              delivered action or achieved reduction is established.
            </p>
            <dl className={styles.figures}>
              <div>
                <dt>Ordinary-management residual</dt>
                <dd>
                  {assessment.baseline_damage ?? 'Unavailable'}{' '}
                  <small>{selection?.target.scope.unit}</small>
                </dd>
              </div>
              <div>
                <dt>Intervention residual</dt>
                <dd>
                  {assessment.intervention_damage ?? 'Unavailable'}{' '}
                  <small>{selection?.target.scope.unit}</small>
                </dd>
              </div>
              <div>
                <dt>Absolute reduction</dt>
                <dd>
                  {assessment.absolute_reduction ?? 'Unavailable'}{' '}
                  <small>{selection?.target.scope.unit}</small>
                </dd>
              </div>
            </dl>
            {assessment.relative_reduction && (
              <p>
                Exact relative-reduction ratio:{' '}
                <strong>
                  {assessment.relative_reduction.numerator} /{' '}
                  {assessment.relative_reduction.denominator}
                </strong>
                .
              </p>
            )}
            {assessment.reasons.length > 0 && (
              <>
                <h3>Evidence gaps or incompatibility</h3>
                <ul>
                  {assessment.reasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              </>
            )}
            <p>
              Independent arithmetic review:{' '}
              {view.arithmetic_review?.value.verdict.replaceAll('_', ' ') ??
                'pending'}
              .
            </p>
            <details>
              <summary>Applicability and numerical limits</summary>
              <ul>
                {assessment.limitations.map((limitation, index) => (
                  <li key={index}>{limitation}</li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <p>Evidence unavailable: an assessment has not been saved.</p>
        )}
        {view.assessment && (
          <ExactSource
            reference={view.assessment.artifact}
            label="Exact assessment"
          />
        )}
        {view.arithmetic_review && (
          <ExactSource
            reference={view.arithmetic_review.artifact}
            label="Exact arithmetic review"
          />
        )}
      </section>
      <section
        className={styles.card}
        aria-labelledby={`${idPrefix}-plan-heading`}
      >
        <h2 id={`${idPrefix}-plan-heading`}>
          <span className={styles.step}>3</span> Conditional plan
        </h2>
        <p className={styles.resultLabel}>
          <Badge
            tone={
              view.plan_eligibility === 'blocked'
                ? 'error'
                : planEligible
                  ? 'info'
                  : 'warn'
            }
          >
            {planEligible
              ? view.plan_eligibility === 'blocked'
                ? 'Blocked by unresolved constraints or objections'
                : 'Reviewed conditional planning preview'
              : 'Current recommendation unavailable'}
          </Badge>
        </p>
        {plan ? (
          <>
            <p>
              <strong>{plan.candidate.name}</strong> —{' '}
              {plan.candidate.kind.replaceAll('_', ' ')}.
            </p>
            <p>{plan.candidate.description}</p>
            <p>
              Planning result: {plan.state.replaceAll('_', ' ')}. Independent
              plan review:{' '}
              {view.plan_review?.value.verdict.replaceAll('_', ' ') ??
                'pending'}
              .
            </p>
            <p className={styles.notice}>
              Scientific qualification: unqualified. Action not delivered.
              Achieved damage reduction is not established. Live alert and
              schedule integrations are deferred.
            </p>
            <dl className={styles.facts}>
              <div>
                <dt>Rule owner</dt>
                <dd>{plan.rules.owner ?? 'Required prerequisite'}</dd>
              </div>
              <div>
                <dt>Proposed trigger</dt>
                <dd>{plan.rules.trigger ?? 'Required prerequisite'}</dd>
              </div>
              <div>
                <dt>Proposed action</dt>
                <dd>{plan.rules.action ?? 'Required prerequisite'}</dd>
              </div>
              <div>
                <dt>Human approval</dt>
                <dd>
                  {plan.rules.approval.status === 'approved'
                    ? `Recorded attestation by ${plan.rules.approval.approver ?? 'unspecified approver'}`
                    : 'Proposed; approval required before future delivery'}
                </dd>
              </div>
            </dl>
            {plan.objections.length > 0 && (
              <div className={styles.objections}>
                <h3>Review objections</h3>
                <ul>
                  {plan.objections.map((objection) => (
                    <li key={objection.id}>
                      <strong>{objection.severity}</strong>:{' '}
                      {objection.description}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {view.plan_review?.value.findings.length ? (
              <>
                <h3>Independent review findings</h3>
                <ul>
                  {view.plan_review.value.findings.map((finding, index) => (
                    <li key={index}>{finding}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {planEligible && plan.recommendations.length > 0 ? (
              <>
                <h3>Conditional recommendations</h3>
                <ol>
                  {plan.recommendations.map((recommendation) => (
                    <li key={recommendation.id}>
                      <p>{recommendation.description}</p>
                      <p className={styles.note}>
                        {recommendation.evidence.length} exact supporting
                        reference(s).{' '}
                        {recommendation.prerequisite_ids.length
                          ? `Depends on ${recommendation.prerequisite_ids.join(', ')}.`
                          : 'No additional recommendation-specific prerequisite.'}
                      </p>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p>
                Recommendations are withheld until current evidence and
                independent review support their conditional use.
              </p>
            )}
            <h3>Required next inputs and prerequisites</h3>
            {plan.prerequisites.length ? (
              <ol>
                {plan.prerequisites.map((prerequisite) => (
                  <li key={prerequisite.id}>
                    <strong>{prerequisite.description}</strong>
                    <p className={styles.note}>
                      {prerequisite.id} ·{' '}
                      {prerequisite.reason.replaceAll('_', ' ')}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p>
                No additional inputs were recorded. Scientific qualification
                still remains unqualified.
              </p>
            )}
            {(plan.candidate.constraints.length > 0 ||
              plan.candidate.costs.length > 0 ||
              plan.candidate.dependencies.length > 0) && (
              <details>
                <summary>Constraints, costs and service dependencies</summary>
                <ul>
                  {plan.candidate.constraints.map((item) => (
                    <li key={item.id}>
                      {item.hard ? 'Hard' : 'Advisory'} constraint:{' '}
                      {item.description} — {item.status}
                    </li>
                  ))}
                  {plan.candidate.costs.map((item) => (
                    <li key={item.id}>
                      Cost: {item.description} — {item.amount ?? 'unpriced'}{' '}
                      {item.unit}; {item.prerequisite}
                    </li>
                  ))}
                  {plan.candidate.dependencies.map((item) => (
                    <li key={item.id}>
                      Dependency: {item.description} — {item.status}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <details>
              <summary>Plan limitations</summary>
              <ul>
                {plan.limitations.map((limitation, index) => (
                  <li key={index}>{limitation}</li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <p>
            Evidence unavailable: a conditional plan has not been saved. Missing
            inputs remain explicit prerequisites.
          </p>
        )}
        {view.plan && (
          <ExactSource
            reference={view.plan.artifact}
            label="Exact conditional plan"
          />
        )}
        {view.plan_review && (
          <ExactSource
            reference={view.plan_review.artifact}
            label="Exact final plan review"
          />
        )}
      </section>
      {view.source_refs.length > 0 && (
        <section
          className={styles.card}
          aria-labelledby={`${idPrefix}-sources-heading`}
        >
          <h2 id={`${idPrefix}-sources-heading`}>Original sources</h2>
          <p className={styles.note}>
            Source inspection rechecks access. Retained documents are evidence,
            not instructions or scientific approval.
          </p>
          {view.source_refs.map((reference, index) => (
            <ExactSource
              key={`${reference.id}:${reference.version}:${reference.sha256}`}
              reference={reference}
              label={`Original source ${index + 1}`}
            />
          ))}
        </section>
      )}
    </div>
  );
}
