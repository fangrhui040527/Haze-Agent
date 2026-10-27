import { Link } from 'react-router';
import snapshot from './data/damage-reduction.json';
import { DemoFrame } from './DemoFrame.tsx';
import { parseReductionDemo } from './recorded-demo.ts';
import styles from './Demos.module.css';

const demo = parseReductionDemo(snapshot);
const { preview } = demo;
const target = preview.selection?.value.target;
const assessment = preview.assessment?.value;
const plan = preview.plan?.value;

const before = Number(assessment?.baseline_damage ?? 0);
const after = Number(assessment?.intervention_damage ?? 0);
const saved = Number(assessment?.absolute_reduction ?? before - after);
const reductionPercent = before ? Math.round((saved / before) * 100) : 0;
const goalPercent = Math.round(Number(target?.target_fraction ?? 0) * 100);
const goalMet = preview.claims?.point_estimate_label === 'meets';
const reviewAgreed = preview.arithmetic_review?.value.verdict === 'supported';

/** Plain-language wording for each recorded prerequisite, by its id. */
const nextStepWording: Record<string, string> = {
  'scientific-applicability':
    'Experts confirm the idea works for real workers, using real data.',
  'rule-owner': 'Choose a person who is responsible for the alerts.',
  'trigger-rule': 'Agree on exactly when an alert should be sent.',
  'action-rule': 'Agree on who receives alerts and what they should do.',
  'human-rule-approval': 'Get formal sign-off on the alert plan.',
  'feasibility-constraints':
    'Check it is practical and keeps every group of workers safe.',
  'cost-1': 'Find out what it would cost and agree a budget.',
  'dependency-1': 'Make sure the alert service can actually be run.',
};

const formatNumber = (value: number) => value.toLocaleString('en-US');

function formatPeriod(start: string, end: string) {
  const month = (date: string) =>
    new Date(date).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  return month(start) === month(end)
    ? month(start)
    : `${month(start)} to ${month(end)}`;
}

export function DamageReductionDemoPage() {
  return (
    <DemoFrame
      title="Could haze alerts protect outdoor workers?"
      description="A worked example showing how Haze estimates whether a new idea would reduce harm from haze, and what still needs to happen before it could be used."
      recordedAt={demo.recorded_at}
    >
      <section className={styles.card} aria-labelledby="reduction-answer">
        <p className={styles.eyebrow}>The short answer</p>
        <h2 id="reduction-answer">
          {goalMet ? 'Yes, on paper.' : 'Not yet.'} Alerts could cut lost
          healthy days by about {reductionPercent}%.
        </h2>
        <p>
          The goal was a cut of at least {goalPercent}%.{' '}
          {goalMet
            ? 'This example goes past that goal.'
            : 'This example does not reach that goal.'}
        </p>
        <div className={styles.compare}>
          <div className={styles.compareRow}>
            <span>Without alerts</span>
            <span className={styles.bar} aria-hidden="true">
              <span style={{ width: '100%' }} />
            </span>
            <strong>{formatNumber(before)} days</strong>
          </div>
          <div className={styles.compareRow}>
            <span>With alerts</span>
            <span
              className={`${styles.bar} ${styles.barGood}`}
              aria-hidden="true"
            >
              <span
                style={{ width: `${before ? (after / before) * 100 : 0}%` }}
              />
            </span>
            <strong>{formatNumber(after)} days</strong>
          </div>
        </div>
        <p className={styles.highlight}>
          That is <strong>{formatNumber(saved)} fewer days</strong> lost to
          illness over the month.
        </p>
      </section>

      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby="reduction-question">
          <h2 id="reduction-question">What was tested</h2>
          <dl className={styles.plainFacts}>
            <div>
              <dt>Who</dt>
              <dd>People who work outdoors</dd>
            </div>
            <div>
              <dt>Where</dt>
              <dd>An example district</dd>
            </div>
            {target && (
              <div>
                <dt>When</dt>
                <dd>
                  {formatPeriod(
                    target.scope.period.start,
                    target.scope.period.end,
                  )}
                </dd>
              </div>
            )}
            <div>
              <dt>The idea</dt>
              <dd>
                Send haze alerts and adjust work schedules on bad air days
              </dd>
            </div>
            <div>
              <dt>Compared with</dt>
              <dd>Today's usual work schedule and protections</dd>
            </div>
          </dl>
        </section>

        <section className={styles.card} aria-labelledby="reduction-trust">
          <h2 id="reduction-trust">How much to trust this</h2>
          <ul className={styles.checks}>
            <li className={reviewAgreed ? styles.yes : styles.no}>
              {reviewAgreed
                ? 'A second, independent reviewer re-checked the numbers and agreed.'
                : 'The numbers have not yet been independently re-checked.'}
            </li>
            <li className={styles.no}>
              The figures are made up for this demo, not taken from real
              workers.
            </li>
            <li className={styles.no}>
              No alerts have been sent, so the real-world effect is not yet
              known.
            </li>
          </ul>
        </section>
      </div>

      {plan && plan.prerequisites.length > 0 && (
        <section className={styles.card} aria-labelledby="reduction-next">
          <h2 id="reduction-next">What needs to happen before it is used</h2>
          <p>Haze suggests these steps before anyone relies on this idea:</p>
          <ol className={styles.steps}>
            {plan.prerequisites.map((prerequisite) => (
              <li key={prerequisite.id}>
                {nextStepWording[prerequisite.id] ?? prerequisite.description}
              </li>
            ))}
          </ol>
        </section>
      )}

      <p>
        <Link to="/damage-reduction">Try it with your own figures</Link>
      </p>
    </DemoFrame>
  );
}
