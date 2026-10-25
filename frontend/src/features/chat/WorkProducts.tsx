import { useEffect, useState } from 'react';
import type {
  Artifact,
  ArtifactRef,
} from '../../../../app/contracts/artifacts.ts';
import { agentService } from '../../services/agents/index.ts';
import { EvidenceResult } from './EvidenceResult.tsx';
import styles from './ChatPanel.module.css';
export function WorkProducts({
  products,
  baseUrl = '',
  rejected = false,
}: {
  products: ArtifactRef[];
  baseUrl?: string;
  rejected?: boolean;
}) {
  if (!products.length)
    return (
      <p className={styles.muted}>
        No work products were accepted for this result.
      </p>
    );
  return (
    <section aria-label="Work products">
      <h3>Work products</h3>
      <ul className={styles.workProducts}>
        {products.map((product) => (
          <WorkProduct
            key={`${product.id}/${product.version}`}
            product={product}
            baseUrl={baseUrl}
            rejected={rejected}
          />
        ))}
      </ul>
    </section>
  );
}
function WorkProduct({
  product,
  baseUrl,
  rejected,
}: {
  product: ArtifactRef;
  baseUrl: string;
  rejected: boolean;
}) {
  const { id, version, sha256 } = product;
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded || artifact || !agentService.readArtifact) return;
    const controller = new AbortController();
    agentService
      .readArtifact(id, controller.signal)
      .then((value) => {
        if (value.version !== version || value.sha256 !== sha256)
          throw new Error(
            'The work product does not match its pinned version and hash.',
          );
        setArtifact(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'The work product could not be loaded.',
          );
      });
    return () => controller.abort();
  }, [expanded, artifact, id, version, sha256]);
  return (
    <li>
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>
          {artifact?.filename ?? artifact?.kind ?? 'Saved work product'} -
          version {product.version}
        </summary>
        <p>
          <a
            href={`${baseUrl}/api/artifacts/${product.id}`}
            target="_blank"
            rel="noreferrer"
          >
            Open exact artifact
          </a>
        </p>
        <p className={styles.hash}>SHA-256 {product.sha256}</p>
        {error && <p role="alert">{error}</p>}
        {expanded && !artifact && !error && (
          <p role="status">Loading work product...</p>
        )}
        {artifact && (
          <>
            <p>
              Producer: {artifact.producer.kind} / {artifact.producer.id}.
              Evidence origin: {artifact.evidence_origin ?? 'unspecified'}.
            </p>
            {!rejected && artifact.kind === 'pm25.analysis' && (
              <EvidenceResult content={artifact.content} />
            )}
            {rejected && (
              <p>
                Domain calculations are withheld because review rejected this
                result.
              </p>
            )}
            <details>
              <summary>Artifact content</summary>
              <pre className={styles.artifactContent}>
                {typeof artifact.content === 'string'
                  ? artifact.content
                  : JSON.stringify(artifact.content, null, 2)}
              </pre>
            </details>
          </>
        )}
      </details>
    </li>
  );
}
