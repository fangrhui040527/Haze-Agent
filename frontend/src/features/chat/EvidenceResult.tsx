import type { JsonValue } from '../../../../app/contracts/artifacts.ts';
import styles from './ChatPanel.module.css';
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** Optional domain detail. General results never require PM2.5 fields. */
export function EvidenceResult({ content }: { content: JsonValue }) {
  const root = object(content);
  const coverage = object(root?.coverage) ?? root;
  if (!coverage || !('usable_row_count' in coverage)) return null;
  const requested = object(coverage.requested);
  const period = object(requested?.period);
  const intervals = Array.isArray(coverage.missing_intervals)
    ? coverage.missing_intervals
    : [];
  return (
    <div className={styles.evidence}>
      <h4>PM2.5 evidence coverage</h4>
      <p>
        Coverage: {String(coverage.status ?? 'unknown').replaceAll('_', ' ')}.{' '}
        {String(coverage.usable_row_count)} usable rows (
        {String(coverage.modeled_count ?? 0)} modeled,{' '}
        {String(coverage.observation_count ?? 0)} observations,{' '}
        {String(coverage.unknown_kind_count ?? 0)} with unknown kind).
      </p>
      {requested && (
        <p>
          {String(requested.location ?? '')}: {String(period?.start ?? '')} to{' '}
          {String(period?.end ?? '')} (end exclusive).
        </p>
      )}
      {intervals.length > 0 && (
        <details>
          <summary>Missing coverage intervals ({intervals.length})</summary>
          <ul>
            {intervals.map((interval, index) => {
              const item = object(interval);
              return (
                <li key={index}>
                  {String(item?.start ?? '')} to {String(item?.end ?? '')} (end
                  exclusive)
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
