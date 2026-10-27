import { Link, useSearchParams } from 'react-router';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import { recordedArtifact } from './recorded-demo.ts';
import styles from './Demos.module.css';

export function DemoArtifact({
  id,
  artifacts,
}: {
  id: string;
  artifacts: readonly Artifact[];
}) {
  const [search] = useSearchParams();
  const artifact = recordedArtifact(artifacts, {
    id,
    version: Number(search.get('version')),
    sha256: search.get('sha256') ?? '',
  });
  return (
    <section className={styles.card} aria-labelledby="recorded-source-heading">
      <Link to="/demos/damage-account">Back to the account demo</Link>
      <h2 id="recorded-source-heading">Recorded exact artifact</h2>
      {artifact ? (
        <>
          <p>
            {artifact.filename ?? artifact.kind} · version {artifact.version}
          </p>
          <p className={styles.identifier}>
            ID {artifact.id}
            <br />
            SHA-256 {artifact.sha256}
          </p>
          <p>
            {artifact.declared_origin ??
              'Retained output from the synthetic example.'}
          </p>
          <pre className={styles.source}>
            {JSON.stringify(artifact.content, null, 2)}
          </pre>
        </>
      ) : (
        <p role="alert">
          This exact version and hash are not included in the recorded demo.
        </p>
      )}
    </section>
  );
}
