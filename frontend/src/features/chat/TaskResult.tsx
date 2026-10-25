import type { AgentAnswer } from '../../shared/types/agents.ts';
import { WorkProducts } from './WorkProducts.tsx';
import styles from './ChatPanel.module.css';
export function TaskResult({
  evidence,
  stale = false,
  showAnswer = false,
}: {
  evidence: NonNullable<AgentAnswer['evidence']>;
  stale?: boolean;
  showAnswer?: boolean;
}) {
  const { result, taskUrl } = evidence;
  const baseUrl = taskUrl.replace(/\/api\/tasks\/[^/]+$/, '');
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
      <WorkProducts
        products={result.work_products}
        baseUrl={baseUrl}
        rejected={result.review.status === 'rejected'}
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
      <a href={taskUrl} target="_blank" rel="noreferrer">
        Saved task and run history
      </a>
    </div>
  );
}
