import { Link, useParams } from 'react-router';
import {
  DamageAccountResult,
  damageArtifactReview,
} from '../damage-account/DamageAccountResult.tsx';
import snapshot from './data/damage-account.json';
import { DemoFrame } from './DemoFrame.tsx';
import { DemoArtifact } from './DemoArtifact.tsx';
import { accountDemoArtifactHref, parseAccountDemo } from './recorded-demo.ts';
import styles from './Demos.module.css';

const demo = parseAccountDemo(snapshot);
const checks = demo.review.checks ?? [];

export function DamageAccountDemoPage() {
  const { artifactId } = useParams<{ artifactId: string }>();
  return (
    <DemoFrame
      title="Damage account demo"
      description="A completed account showing physical harm, financing, social welfare, scenario comparisons and exact independent reviews."
      recordedAt={demo.recorded_at}
    >
      {artifactId ? (
        <DemoArtifact id={artifactId} artifacts={demo.artifacts} />
      ) : (
        <>
          <section
            className={styles.card}
            aria-label="Recorded account results"
          >
            <h2>Recorded account results</h2>
            <DamageAccountResult
              content={demo.account.content}
              checks={checks}
              reviewStatus={damageArtifactReview(
                demo.account,
                checks,
                'damage.account',
              )}
              artifactHref={accountDemoArtifactHref}
              recorded
            />
          </section>
          <section
            className={styles.card}
            aria-labelledby="account-demo-reviews"
          >
            <h2 id="account-demo-reviews">
              Independent reviews from the recorded run
            </h2>
            <p>{demo.review.scope}</p>
            <ul className={styles.reviewList}>
              {checks.map((check) => (
                <li key={`${check.artifact.id}/${check.artifact.version}`}>
                  <Link to={accountDemoArtifactHref(check.artifact)}>
                    Exact reviewed artifact
                  </Link>{' '}
                  — {check.verdict.replaceAll('_', ' ')}
                  {check.review_artifact && (
                    <>
                      {' '}
                      ·{' '}
                      <Link to={accountDemoArtifactHref(check.review_artifact)}>
                        Open independent review
                      </Link>
                    </>
                  )}
                  {check.limitations.map((limitation) => (
                    <p key={limitation}>{limitation}</p>
                  ))}
                </li>
              ))}
            </ul>
          </section>
          <p>
            <Link to="/damage-account">Build your own account</Link>
          </p>
        </>
      )}
    </DemoFrame>
  );
}
