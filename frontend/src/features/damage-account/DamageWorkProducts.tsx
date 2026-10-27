import { useEffect, useState } from 'react';
import type {
  Artifact,
  ArtifactRef,
} from '../../../../app/contracts/artifacts.ts';
import type { ArtifactReviewCheck } from '../../../../app/contracts/manager.ts';
import { damageAccountSchema } from '../../../../app/contracts/damage-account.ts';
import { agentService } from '../../services/agents/index.ts';

import {
  DamageAccountResult,
  damageArtifactReview,
} from './DamageAccountResult.tsx';
import styles from '../chat/ChatPanel.module.css';
import { DamageEvidenceResult } from '../chat/DamageEvidenceResult.tsx';
export function DamageWorkProducts({
  products,
  baseUrl = '',
  rejected = false,
  rejectedProducts = [],
  reviewChecks = [],
  stale = false,
}: {
  products: ArtifactRef[];
  baseUrl?: string;
  rejected?: boolean;
  rejectedProducts?: ArtifactRef[];
  reviewChecks?: readonly ArtifactReviewCheck[];
  stale?: boolean;
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
            initiallyExpanded
            reviewChecks={reviewChecks}
            stale={stale}
            rejected={
              rejected ||
              rejectedProducts.some(
                (reference) =>
                  reference.id === product.id &&
                  reference.version === product.version &&
                  reference.sha256 === product.sha256,
              )
            }
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
  reviewChecks,
  stale,
  label,
  initiallyExpanded = false,
}: {
  product: ArtifactRef;
  baseUrl: string;
  rejected: boolean;
  reviewChecks: readonly ArtifactReviewCheck[];
  stale: boolean;
  label?: string;
  initiallyExpanded?: boolean;
}) {
  const { id, version, sha256 } = product;
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const account =
    artifact?.kind === 'damage.account'
      ? damageAccountSchema.safeParse(artifact.content)
      : null;
  const reviewStatus = rejected
    ? 'rejected'
    : damageArtifactReview(product, reviewChecks, artifact?.kind ?? label);
  useEffect(() => {
    if (!expanded || artifact || !agentService.readArtifact) return;
    const controller = new AbortController();
    agentService
      .readArtifact(id, controller.signal)
      .then((value) => {
        if (
          value.id !== id ||
          value.version !== version ||
          value.sha256 !== sha256
        )
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
      {rejected && (
        <p className={styles.staleResult}>
          This artifact was rejected in review. Domain calculations are
          withheld.
        </p>
      )}
      <details
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          {artifact?.filename ??
            artifact?.kind ??
            label ??
            'Saved work product'}{' '}
          - version {product.version}
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
            {artifact.kind.startsWith('damage.') && (
              <DamageAccountResult
                kind={artifact.kind}
                content={artifact.content}
                baseUrl={baseUrl}
                reviewStatus={reviewStatus}
                checks={reviewChecks}
                stale={stale}
              />
            )}
            {!rejected && !stale && (
              <DamageEvidenceResult
                content={artifact.content}
                baseUrl={baseUrl}
              />
            )}
            {account?.success && (
              <section aria-label="Exact account components">
                <h4>Account component records</h4>
                <p>
                  Open a component to inspect uncertainty, source-fire
                  omissions, financing and inclusion decisions.
                </p>
                <ul className={styles.workProducts}>
                  {account.data.component_refs.map((component) => (
                    <WorkProduct
                      key={`${component.artifact.id}/${component.artifact.version}`}
                      product={component.artifact}
                      label={component.kind}
                      baseUrl={baseUrl}
                      rejected={
                        rejected ||
                        damageArtifactReview(
                          component.artifact,
                          reviewChecks,
                        ) === 'rejected'
                      }
                      reviewChecks={reviewChecks}
                      stale={stale}
                    />
                  ))}
                </ul>
              </section>
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
