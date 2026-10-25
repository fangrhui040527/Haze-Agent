import type { AgentAnswer, Citation } from '../../shared/types/agents.ts';
import styles from './ChatPanel.module.css';

export function EvidenceResult({
  evidence,
  citations,
}: {
  evidence: NonNullable<AgentAnswer['evidence']>;
  citations: Citation[];
}) {
  const { result } = evidence;
  const { coverage, provenance, review } = result;
  return (
    <div className={styles.evidence}>
      {'completion' in result && (
        <p>
          Result: {result.completion}. Review:{' '}
          {review.status.replaceAll('_', ' ')}.
          {result.completion === 'partial'
            ? ' Some requested evidence remains unavailable.'
            : ''}
          {result.completion === 'blocked'
            ? ' The available evidence does not support an answer.'
            : ''}
        </p>
      )}
      {coverage ? (
        <>
          <p>
            Coverage: {coverage.status.replaceAll('_', ' ')}.{' '}
            {coverage.usable_row_count} usable rows ({coverage.modeled_count}{' '}
            modeled, {coverage.observation_count} observations,{' '}
            {coverage.unknown_kind_count} with unknown kind).
          </p>
          <p>
            {coverage.requested.location}: {coverage.requested.period.start} to{' '}
            {coverage.requested.period.end} (end exclusive).
          </p>
        </>
      ) : (
        <p>Coverage calculations were withheld after evidence review.</p>
      )}
      {result.findings.length > 0 && (
        <>
          <h3>Supported findings</h3>
          <ul>
            {result.findings.map((finding, index) => (
              <li key={index}>
                {finding.text}{' '}
                {finding.citation_ids.map((id) => {
                  const citation = citations.find((item) => item.id === id);
                  return citation?.href ? (
                    <a
                      key={id}
                      href={citation.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      [{id}]
                    </a>
                  ) : (
                    <span key={id}>[{id}]</span>
                  );
                })}
              </li>
            ))}
          </ul>
        </>
      )}
      {coverage && coverage.missing_intervals.length > 0 && (
        <details>
          <summary>
            Missing coverage intervals ({coverage.missing_intervals.length})
          </summary>
          <ul>
            {coverage.missing_intervals.map((interval) => (
              <li key={`${interval.start}/${interval.end}`}>
                {interval.start} to {interval.end} (end exclusive)
              </li>
            ))}
          </ul>
        </details>
      )}
      {result.unresolved_gaps.length > 0 && (
        <>
          <h3>Unresolved gaps</h3>
          <ul>
            {result.unresolved_gaps.map((gap, index) => (
              <li key={index}>{gap}</li>
            ))}
          </ul>
        </>
      )}
      {result.assumptions.length > 0 && (
        <details>
          <summary>Assumptions</summary>
          <ul>
            {result.assumptions.map((assumption, index) => (
              <li key={index}>{assumption}</li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary>Review and actual execution provenance</summary>
        <p>Review: {review.scope}</p>
        <ul>
          {review.limitations.map((limitation, index) => (
            <li key={index}>{limitation}</li>
          ))}
        </ul>
        <p>
          Mode: {provenance.mode}. Source: {provenance.source}. Retrieved:{' '}
          {provenance.retrieved_at}.
        </p>
        <p>
          Requested model route: {provenance.model.provider} /{' '}
          {provenance.model.model}; {provenance.model.calls} call(s). Tools:{' '}
          {provenance.tool_calls} call(s).
        </p>
        <p>
          Returned model:{' '}
          {provenance.model.receipt?.response_model ?? 'not reported'}. Input
          tokens: {provenance.model.receipt?.input_tokens ?? 'not reported'};{' '}
          output tokens:{' '}
          {provenance.model.receipt?.output_tokens ?? 'not reported'}.
        </p>
        <p>Method: {provenance.method}.</p>
        <a href={evidence.taskUrl} target="_blank" rel="noreferrer">
          Open persisted task and result
        </a>
      </details>
    </div>
  );
}
