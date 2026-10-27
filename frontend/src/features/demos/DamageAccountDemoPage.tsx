import { Link, useParams } from 'react-router';
import snapshot from './data/damage-account.json';
import { DemoFrame } from './DemoFrame.tsx';
import { DemoArtifact } from './DemoArtifact.tsx';
import { parseAccountDemo } from './recorded-demo.ts';
import styles from './Demos.module.css';

const demo = parseAccountDemo(snapshot);
const account = demo.accountValue;
const checks = demo.review.checks ?? [];
const checksAgreed = checks.filter(
  (check) => check.verdict === 'supported',
).length;

const { historical_scenario_id: historicalId } = account.scope;
const project = account.scenarios.find(
  (scenario) =>
    scenario.comparator_id === historicalId && scenario.status === 'available',
);
const totalFor = (scenarioId: string | undefined) =>
  account.welfare_totals.find((total) => total.scenario_id === scenarioId)
    ?.amount;
const harmTotal = totalFor(historicalId) ?? 0;
const harmWithProject = totalFor(project?.scenario_id);

/** Plain-language names for each recorded kind of harm, by endpoint id. */
const harmWording: Record<string, string> = {
  mortality: 'Deaths',
  treatment: 'People needing medical treatment',
  discomfort: 'People with symptoms such as coughs or sore eyes',
  production: 'Lost work output',
  protection: 'Masks and other protection needed',
  transport: 'Travel disruption',
};

const harms = account.scope.endpoints.map((endpoint) => {
  const quantity = (scenarioId: string | undefined) =>
    account.physical_totals.find(
      (total) =>
        total.endpoint_id === endpoint && total.scenario_id === scenarioId,
    )?.quantity;
  return {
    endpoint,
    without: quantity(historicalId),
    withProject: quantity(project?.scenario_id),
  };
});

const formatMoney = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)} million`
    : value.toLocaleString('en-US', { maximumFractionDigits: 0 });
const formatCount = (value: number | undefined) =>
  value === undefined
    ? '—'
    : value.toLocaleString('en-US', { maximumFractionDigits: 1 });

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

export function DamageAccountDemoPage() {
  const { artifactId } = useParams<{ artifactId: string }>();
  return (
    <DemoFrame
      title="What did a haze season cost?"
      description="A worked example showing how Haze adds up the harm caused by haze, and whether a prevention project would be worth paying for."
      recordedAt={demo.recorded_at}
    >
      {artifactId ? (
        <DemoArtifact id={artifactId} artifacts={demo.artifacts} />
      ) : (
        <>
          <section className={styles.card} aria-labelledby="account-answer">
            <p className={styles.eyebrow}>The short answer</p>
            <h2 id="account-answer">
              The haze caused about {formatMoney(harmTotal)} in harm.
            </h2>
            <p>
              That adds up health problems, lost work and everyday costs for
              people living in the affected area. Amounts are in made-up
              currency units.
            </p>
            {project?.benefit_cost_ratio != null && (
              <p className={styles.highlight}>
                A prevention project would return about{' '}
                <strong>{project.benefit_cost_ratio.toFixed(2)}</strong> for
                every 1 spent.
              </p>
            )}
          </section>

          <section className={styles.card} aria-labelledby="account-harms">
            <h2 id="account-harms">What the harm was made of</h2>
            <table className={styles.plainTable}>
              <thead>
                <tr>
                  <th scope="col">Kind of harm</th>
                  <th scope="col">From the haze</th>
                  {project && <th scope="col">With the project</th>}
                </tr>
              </thead>
              <tbody>
                {harms.map((harm) => (
                  <tr key={harm.endpoint}>
                    <th scope="row">
                      {harmWording[harm.endpoint] ?? harm.endpoint}
                    </th>
                    <td>{formatCount(harm.without)}</td>
                    {project && <td>{formatCount(harm.withProject)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {project && harmWithProject !== undefined && (
            <section className={styles.card} aria-labelledby="account-project">
              <h2 id="account-project">Would a prevention project pay off?</h2>
              <div className={styles.compare}>
                <div className={styles.compareRow}>
                  <span>Without the project</span>
                  <span className={styles.bar} aria-hidden="true">
                    <span style={{ width: '100%' }} />
                  </span>
                  <strong>{formatMoney(harmTotal)}</strong>
                </div>
                <div className={styles.compareRow}>
                  <span>With the project</span>
                  <span
                    className={`${styles.bar} ${styles.barGood}`}
                    aria-hidden="true"
                  >
                    <span
                      style={{
                        width: `${harmTotal ? (harmWithProject / harmTotal) * 100 : 0}%`,
                      }}
                    />
                  </span>
                  <strong>{formatMoney(harmWithProject)}</strong>
                </div>
              </div>
              <dl className={styles.plainFacts}>
                {project.avoided_damage != null && (
                  <div>
                    <dt>Harm avoided</dt>
                    <dd>{formatMoney(project.avoided_damage)}</dd>
                  </div>
                )}
                {project.project_cost != null && (
                  <div>
                    <dt>Project cost</dt>
                    <dd>{formatMoney(project.project_cost)}</dd>
                  </div>
                )}
                {project.net_benefit != null && (
                  <div>
                    <dt>Overall gain</dt>
                    <dd>{formatMoney(project.net_benefit)}</dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          <div className={styles.grid}>
            <section className={styles.card} aria-labelledby="account-scope">
              <h2 id="account-scope">What was counted</h2>
              <dl className={styles.plainFacts}>
                <div>
                  <dt>Where</dt>
                  <dd>An example region</dd>
                </div>
                <div>
                  <dt>When</dt>
                  <dd>
                    {formatPeriod(
                      account.scope.effect_period.start,
                      account.scope.effect_period.end,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Who bears it</dt>
                  <dd>
                    Households, government, insurers, health providers and
                    businesses
                  </dd>
                </div>
                <div>
                  <dt>Not counted</dt>
                  <dd>Damage from the fires themselves, only their smoke</dd>
                </div>
              </dl>
            </section>

            <section className={styles.card} aria-labelledby="account-trust">
              <h2 id="account-trust">How much to trust this</h2>
              <ul className={styles.checks}>
                <li
                  className={
                    checks.length && checksAgreed === checks.length
                      ? styles.yes
                      : styles.no
                  }
                >
                  Independent reviewers re-checked the calculations (
                  {checksAgreed} of {checks.length} agreed).
                </li>
                <li className={styles.no}>
                  The figures are made up for this demo, not from a real haze
                  season.
                </li>
                <li className={styles.no}>
                  It shows the size of the harm, not who is to blame for it.
                </li>
              </ul>
            </section>
          </div>

          <p>
            <Link to="/damage-account">Try it with your own figures</Link>
          </p>
        </>
      )}
    </DemoFrame>
  );
}
