import { useMemo } from 'react';
import {
  demoChatResponseSchema,
  type DemoChatResponse,
} from '../../../../app/demo/chat-contract.ts';
import type { ImmutableReference } from '../../../../app/contracts/common.ts';
import type { PlanningBundle } from '../../../../app/contracts/planning.ts';
import {
  checkedQuantification,
  sameReference,
  scheduleDate,
  scheduleOffset,
  scheduleRows,
  scheduleTime,
} from './scheduleDisplay.ts';
import styles from './ScheduleResult.module.css';

const label = (value: string) => value.replaceAll('_', ' ');
const number = (value: number) =>
  new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value);

const outcomeLabels = {
  input_blocked: 'Input rejected',
  insufficient_evidence: 'Evidence incomplete',
  action_candidate_found: 'Engineering candidate found',
  below_action_threshold: 'No candidate meets the action threshold',
  no_eligible_plan_found: 'No eligible candidate found',
  no_improvement_in_declared_set: 'No improvement in the checked set',
  search_ended_without_verified_improvement:
    'Search ended without verified improvement',
  improvement_not_established: 'Improvement not established',
} as const;

export function ScheduleResult({ response }: { response: DemoChatResponse }) {
  const parsed = useMemo(
    () => demoChatResponseSchema.safeParse(response),
    [response],
  );
  if (!parsed.success) {
    return (
      <p className={styles.issues} role="alert">
        This saved scheduling result could not be validated. Send the fictional
        crew request again to load a checked result. No numerical comparison is
        shown.
      </p>
    );
  }
  return <ValidatedScheduleResult response={parsed.data} />;
}

function ValidatedScheduleResult({ response }: { response: DemoChatResponse }) {
  const { planning, result: envelope } = response;
  const { result } = envelope;
  const values = checkedQuantification(envelope);
  const notices = [
    ...envelope.input_assessment.field_reasons,
    ...envelope.errors,
    ...envelope.evidence.gaps,
  ].filter(
    (reason, index, all) =>
      all.findIndex(
        (entry) =>
          entry.code === reason.code &&
          entry.explanation === reason.explanation,
      ) === index,
  );
  const plans = [
    {
      ref: planning.baseline.ref,
      plan_id: 'baseline',
      assignments: planning.baseline.assignments,
    },
    ...response.plans.filter(
      (plan) => !sameReference(plan.ref, planning.baseline.ref),
    ),
  ];

  return (
    <section
      className={styles.result}
      aria-label="Klang crew scheduling result"
    >
      <div className={styles.heading}>
        <h3>Klang crew scheduling</h3>
        <span className={styles.status}>Draft for review</span>
      </div>
      <p>
        <strong>{outcomeLabels[result.decision_outcome]}.</strong>{' '}
        {result.selected_plan_ref
          ? 'Selected for fictional engineering review only.'
          : 'Baseline retained; no plan selected.'}
      </p>
      <p className={styles.notice}>
        Fictional sample · Historical harness · Publication disabled ·
        Operational recommendation disabled
      </p>
      <p className={styles.caption}>
        Read-only result snapshot. This draft does not approve or change any
        schedule.
      </p>

      <dl className={styles.metadata}>
        <div>
          <dt>Assessment</dt>
          <dd>{scheduleDate(planning.assessment.start, planning.timezone)}</dd>
        </div>
        <div>
          <dt>Horizon</dt>
          <dd>
            {scheduleTime(planning.assessment.start, planning.timezone)}–
            {scheduleTime(planning.assessment.end, planning.timezone)}
            {scheduleDate(planning.assessment.start, planning.timezone) !==
            scheduleDate(planning.assessment.end, planning.timezone)
              ? ` (${scheduleDate(planning.assessment.end, planning.timezone)})`
              : ''}
          </dd>
        </div>
        <div>
          <dt>Timezone</dt>
          <dd>
            {planning.timezone} (
            {scheduleOffset(planning.assessment.start, planning.timezone)})
          </dd>
        </div>
        <div>
          <dt>Input validation</dt>
          <dd>
            {label(envelope.input_assessment.status)} ·{' '}
            {label(envelope.input_origin)}
          </dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>{label(result.evidence_status)}</dd>
        </div>
      </dl>

      {notices.length > 0 && (
        <div className={styles.issues} role="note">
          <strong>Input and evidence issues</strong>
          <ul>
            {notices.map((reason) => (
              <li key={`${reason.code}:${reason.explanation}`}>
                {reason.explanation} <code>{reason.code}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {values ? (
        <div className={styles.quantified}>
          <h4>Checked fictional exposure proxy</h4>
          <p>
            Baseline <strong>{number(values.nominal.baseline)}</strong> →{' '}
            {sameReference(values.plan_ref, result.selected_plan_ref)
              ? 'selected candidate'
              : 'comparison plan'}{' '}
            <strong>{number(values.nominal.candidate)}</strong>{' '}
            {values.crew_unit}.
          </p>
          <p>
            Reduction: {number(values.nominal.absolute_gain)}
            {values.nominal.percentage_gain === null
              ? ''
              : ` (${number(values.nominal.percentage_gain)}%)`}
            . These are engineering illustration values.
          </p>
        </div>
      ) : (
        <p className={styles.notice}>
          No verified numerical comparison is available.{' '}
          {result.quantified_reason?.explanation}
        </p>
      )}

      <div className={styles.selection}>
        <p>
          <strong>Selected plan:</strong>{' '}
          {result.selected_plan_ref
            ? planName(response, result.selected_plan_ref)
            : 'None'}
          . {result.selected_plan_reason?.explanation}
        </p>
        <p>
          <strong>Comparison plan:</strong>{' '}
          {result.comparison_plan_ref
            ? planName(response, result.comparison_plan_ref)
            : 'None'}
          . {result.comparison_plan_reason?.explanation}
        </p>
      </div>

      <p className={styles.caption}>
        Each shared activity appears once with all assigned workers. Bars use
        the full assessment horizon; text supplies exact times.
      </p>
      {plans.map((plan) => {
        const isBaseline = sameReference(plan.ref, planning.baseline.ref);
        const isSelected = sameReference(plan.ref, result.selected_plan_ref);
        const isComparison = sameReference(
          plan.ref,
          result.comparison_plan_ref,
        );
        const role = isBaseline
          ? 'Baseline'
          : isSelected
            ? 'Selected engineering candidate'
            : isComparison
              ? 'Comparison only — not selected'
              : 'Illustrated alternative — not selected';
        const check = result.plan_verification.find((entry) =>
          sameReference(entry.plan_ref, plan.ref),
        );
        return (
          <details
            className={styles.plan}
            key={`${plan.ref.id}:${plan.ref.revision}:${plan.ref.sha256}`}
            open={isBaseline || isSelected}
          >
            <summary>
              <strong>{role}</strong>
              <span>{plan.plan_id}</span>
            </summary>
            <div className={styles.planBody}>
              {check && (
                <p className={styles.caption}>
                  Independent check: {label(check.checker_status)} · Worker
                  protection: {label(check.worker_protection)} · Activity
                  protection: {label(check.activity_protection)} · Feasibility:{' '}
                  {label(check.feasibility)} · Action threshold:{' '}
                  {label(check.action_threshold_status)} · Uncertainty:{' '}
                  {label(check.uncertainty_status)}
                </p>
              )}
              <PlanTimeline bundle={planning} assignments={plan.assignments} />
              <ReferenceDetails
                title="Plan version and reference"
                reference={plan.ref}
              />
            </div>
          </details>
        );
      })}

      <details className={styles.details}>
        <summary>Review, limitations and references</summary>
        <div className={styles.detailBody}>
          <p>
            <strong>Human review:</strong> {label(result.review_status)}.{' '}
            {result.next_decision}
          </p>
          {result.blockers.length > 0 && (
            <ul>
              {result.blockers.map((reason, i) => (
                <li key={`${reason.code}:${i}`}>{reason.explanation}</li>
              ))}
            </ul>
          )}
          {envelope.limitations.length > 0 && (
            <ul>
              {envelope.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          )}
          <p>
            <strong>Contracts:</strong> {planning.schema_version} →{' '}
            {envelope.schema_version}
          </p>
          <p>
            <strong>Run:</strong> <code>{envelope.run_id}</code>
          </p>
          <ReferenceDetails
            title="Planning bundle version and reference"
            reference={envelope.decision_ref.bundle_ref}
          />
        </div>
      </details>
    </section>
  );
}

function planName(response: DemoChatResponse, reference: ImmutableReference) {
  return (
    response.plans.find((plan) => sameReference(plan.ref, reference))
      ?.plan_id ?? reference.id
  );
}

function PlanTimeline({
  bundle,
  assignments,
}: {
  bundle: PlanningBundle;
  assignments: PlanningBundle['baseline']['assignments'];
}) {
  const { rows, errors, occupancy } = scheduleRows(bundle, assignments);
  const from = Date.parse(bundle.assessment.start);
  const horizon = Date.parse(bundle.assessment.end) - from;
  return (
    <>
      <div className={styles.axis} aria-hidden="true">
        <span>{scheduleTime(bundle.assessment.start, bundle.timezone)}</span>
        <span>{scheduleTime(bundle.assessment.end, bundle.timezone)}</span>
      </div>
      <ol
        className={styles.activities}
        aria-label="Activities in start-time order"
      >
        {rows.map(({ activity, start, end }) => {
          const left = Math.max(
            0,
            Math.min(100, ((start - from) / horizon) * 100),
          );
          const width = Math.max(
            0,
            Math.min(
              100 - left,
              ((end - Math.max(start, from)) / horizon) * 100,
            ),
          );
          const location = bundle.locations.find(
            (entry) => entry.location_id === activity.location_id,
          );
          return (
            <li key={activity.activity_id}>
              <div className={styles.activityHeading}>
                <strong>{activity.activity_id}</strong>
                <span className={styles.timing}>
                  {activity.timing_rule === 'fixed_baseline_start'
                    ? 'Fixed'
                    : 'Movable'}
                </span>
              </div>
              <p className={styles.time}>
                {scheduleTime(start, bundle.timezone)}–
                {scheduleTime(end, bundle.timezone)} ·{' '}
                {activity.duration_minutes} min
              </p>
              <p>
                Workers: {activity.worker_ids.join(', ')} · Location:{' '}
                {activity.location_id}
                {location ? ` (${label(location.microenvironment)})` : ''}
              </p>
              <div className={styles.track} aria-hidden="true">
                <span
                  className={
                    activity.timing_rule === 'fixed_baseline_start'
                      ? styles.fixedBar
                      : styles.bar
                  }
                  style={{ marginLeft: `${left}%`, width: `${width}%` }}
                />
              </div>
            </li>
          );
        })}
      </ol>
      {errors.length === 0 && occupancy.length === 0 ? (
        <p className={styles.coverage}>
          Complete occupancy for every worker; no gaps or overlaps.
        </p>
      ) : (
        <div className={styles.issues}>
          <strong>Occupancy needs review</strong>
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
            {occupancy.map((issue, i) => (
              <li key={`${issue.workerId}:${issue.kind}:${i}`}>
                {issue.kind === 'gap'
                  ? 'Gap / incomplete occupancy'
                  : 'Overlap'}
                : {issue.workerId}, {scheduleTime(issue.start, bundle.timezone)}
                –{scheduleTime(issue.end, bundle.timezone)}.
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ReferenceDetails({
  title,
  reference,
}: {
  title: string;
  reference: ImmutableReference;
}) {
  return (
    <details className={styles.reference}>
      <summary>
        {title} · r{reference.revision}
      </summary>
      <p>
        <code>{reference.id}</code>
      </p>
      <p>
        SHA-256: <code>{reference.sha256}</code>
      </p>
    </details>
  );
}
