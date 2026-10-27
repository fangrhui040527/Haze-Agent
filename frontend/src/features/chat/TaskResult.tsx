import type { AgentAnswer } from '../../shared/types/agents.ts';
import { Link } from 'react-router';
import { WorkProducts } from './WorkProducts.tsx';
import { SmokeLedgerGlobe } from './SmokeLedgerGlobe.tsx';
import styles from './ChatPanel.module.css';
export function TaskResult({
  evidence,
  stale = false,
  showAnswer = false,
  linkToReport = true,
}: {
  evidence: NonNullable<AgentAnswer['evidence']>;
  stale?: boolean;
  showAnswer?: boolean;
  linkToReport?: boolean;
}) {
  const { result, taskUrl } = evidence;
  const baseUrl = taskUrl.replace(/\/api\/tasks\/[^/]+$/, '');
  const taskId = /\/api\/tasks\/([^/?#]+)$/.exec(taskUrl)?.[1];
  const isStale = stale || result.currency === 'stale';
  return (
    <div className={styles.evidence}>
      {isStale && (
        <p className={styles.staleResult} role="status">
          Stale result - retained for history. A later correction or run
          requires a current answer.
        </p>
      )}
      {showAnswer &&
        result.answer
          .split(/\n\s*\n/)
          .map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      <p>
        Result: {result.completion}. Review:{' '}
        {result.review.status.replaceAll('_', ' ')}. Currency:{' '}
        {isStale ? 'stale' : 'current'}.
      </p>
      {result.review.checks && result.review.checks.length > 0 && (
        <section aria-label="Artifact review checks">
          <h3>Artifact review checks</h3>
          <ul>
            {result.review.checks.map((check, index) => (
              <li key={`${check.artifact.id}-${index}`}>
                <a
                  href={`${baseUrl}/api/artifacts/${check.artifact.id}`}
                  target="_blank"
                  rel="noreferrer"
                  title={`SHA-256 ${check.artifact.sha256}`}
                >
                  Artifact version {check.artifact.version}
                </a>
                : {check.verdict.replaceAll('_', ' ')}
                <details>
                  <summary>Exact review evidence</summary>
                  <p className={styles.hash}>
                    Producer {check.producer_assignment_id}, revision{' '}
                    {check.producer_revision}.{' '}
                    {check.reviewer_assignment_id
                      ? `Reviewer ${check.reviewer_assignment_id}, revision ${check.reviewer_revision}.`
                      : 'Independent review is pending.'}
                  </p>
                  {check.review_artifact && (
                    <a
                      href={`${baseUrl}/api/artifacts/${check.review_artifact.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Review artifact, version {check.review_artifact.version}
                    </a>
                  )}
                </details>
                {check.limitations.length > 0 && (
                  <div>
                    {check.verdict !== 'supported' && (
                      <strong>Review objections</strong>
                    )}
                    <ul>
                      {check.limitations.map((limitation, item) => (
                        <li key={item}>{limitation}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {result.review.status !== 'rejected' && (
        <SmokeLedgerGlobe products={result.work_products} />
      )}
      <WorkProducts
        products={result.work_products}
        baseUrl={baseUrl}
        rejected={result.review.status === 'rejected'}
        rejectedProducts={result.review.checks?.flatMap((check) =>
          check.verdict === 'rejected' ? [check.artifact] : [],
        )}
      />
      {result.sources.length > 0 && (
        <section aria-label="Result sources">
          <h3>Sources</h3>
          <ul>
            {result.sources.map((source) => (
              <li key={source.id}>
                <a
                  href={`${baseUrl}/api/artifacts/${source.artifact.id}`}
                  target="_blank"
                  rel="noreferrer"
                  title={`SHA-256 ${source.artifact.sha256}`}
                >
                  [{source.id}] {source.label} - version{' '}
                  {source.artifact.version}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <details>
        <summary>Covered scope</summary>
        <pre className={styles.artifactContent}>
          {JSON.stringify(result.covered_scope, null, 2)}
        </pre>
      </details>
      {result.uncertainty.length > 0 && (
        <section>
          <h3>Uncertainty and gaps</h3>
          <ul>
            {result.uncertainty.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>
      )}
      {result.next_requirements.length > 0 && (
        <section>
          <h3>What is needed next</h3>
          <ul>
            {result.next_requirements.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>
      )}
      <details>
        <summary>Review and actual execution provenance</summary>
        <p>{result.review.scope}</p>
        <ul>
          {result.review.limitations.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
        <p>
          Mode: {result.provenance.mode}. {result.provenance.model_calls} model
          calls; {result.provenance.tool_calls} tool attempts.
        </p>
        <ul>
          {result.provenance.capabilities.map((capability) => (
            <li key={capability.id}>
              {capability.id} / {capability.version}
            </li>
          ))}
        </ul>
        <details>
          <summary>
            Persisted receipts ({result.provenance.receipts.length})
          </summary>
          <pre className={styles.artifactContent}>
            {JSON.stringify(result.provenance.receipts, null, 2)}
          </pre>
        </details>
      </details>
      {linkToReport && taskId && (
        <p>
          <Link to={`/task/${encodeURIComponent(taskId)}`}>
            Open task report
          </Link>
        </p>
      )}
      <a href={taskUrl} target="_blank" rel="noreferrer">
        Saved task and run history
      </a>
    </div>
  );
}
