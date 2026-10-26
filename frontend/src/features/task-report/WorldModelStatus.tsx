import { useEffect, useState } from 'react';
import type {
  WorldAcceptanceOutcome,
  WorldRecord,
} from '../../../../app/contracts/world.ts';
import type {
  WorldRecordReadResponse,
  WorldTaskResponse,
} from '../../../../app/contracts/world-api.ts';
import { agentService } from '../../services/agents/index.ts';
import { Badge, type Tone } from '../../shared/ui/Badge.tsx';
import styles from './TaskPage.module.css';

const statusPresentation: Record<
  WorldAcceptanceOutcome['status'] | 'none',
  { label: string; tone: Tone }
> = {
  accepted: { label: 'Accepted for stated use', tone: 'ok' },
  pending_review: { label: 'Pending review', tone: 'info' },
  held: { label: 'Held', tone: 'warn' },
  superseded: { label: 'Superseded', tone: 'stale' },
  not_eligible: { label: 'Not eligible', tone: 'error' },
  none: { label: 'No acceptance record', tone: 'neutral' },
};

function recordLimitations(record: WorldRecord): string[] {
  if (
    typeof record.payload !== 'object' ||
    record.payload === null ||
    Array.isArray(record.payload) ||
    !('limitations' in record.payload) ||
    !Array.isArray(record.payload.limitations)
  )
    return [];
  return record.payload.limitations.filter(
    (value): value is string => typeof value === 'string',
  );
}

function RecordLineage({ recordId }: { recordId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [lineage, setLineage] = useState<
    Extract<WorldRecordReadResponse, { view: 'lineage' }>['lineage'] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setLineage(null);
    setError(null);
    const read = agentService.readWorldRecord?.bind(agentService);
    if (!read) {
      setError('This task service cannot read World Model lineage.');
      return () => controller.abort();
    }
    read(recordId, 'lineage', { limit: 50 }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        if (response.view !== 'lineage')
          throw new Error('The World Model did not return lineage.');
        setLineage(response.lineage);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'World Model lineage could not be loaded.',
          );
      });
    return () => controller.abort();
  }, [expanded, recordId]);
  return (
    <div className={styles.worldLineage}>
      <button
        type="button"
        className={styles.worldToggle}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? 'Hide history' : 'Show history and lineage'}
      </button>
      {expanded && (
        <div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {!error && !lineage && (
            <p className={styles.placeholder} role="status">
              Loading record history...
            </p>
          )}
          {lineage && (
            <ol className={styles.worldHistory}>
              {lineage.entries.map((entry) => (
                <li key={entry.event_id}>
                  <strong>{entry.event_kind}</strong>
                  <span>
                    {' '}
                    by {entry.actor.id} at{' '}
                    <time dateTime={entry.recorded_at}>
                      {entry.recorded_at}
                    </time>
                  </span>
                  {entry.hold && <p>Hold reason: {entry.hold.reason}</p>}
                  {entry.acceptance && (
                    <p>
                      Acceptance status: {entry.acceptance.status}; use:{' '}
                      {entry.acceptance.stated_use}.
                    </p>
                  )}
                </li>
              ))}
              {lineage.page.has_more && (
                <li>More history is available from the record endpoint.</li>
              )}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function AcceptanceDetails({
  acceptance,
}: {
  acceptance: WorldAcceptanceOutcome;
}) {
  return (
    <div className={styles.worldAcceptance}>
      <p>
        Use: <strong>{acceptance.stated_use}</strong>
      </p>
      <p>
        Policy: {acceptance.policy.id} version {acceptance.policy.version}
      </p>
      {acceptance.expires_at && (
        <p>
          Valid until{' '}
          <time dateTime={acceptance.expires_at}>{acceptance.expires_at}</time>
        </p>
      )}
      {acceptance.status === 'pending_review' ||
      acceptance.status === 'not_eligible' ? (
        <ul>
          {acceptance.reasons.map((reason, index) => (
            <li key={`${index}-${reason}`}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {acceptance.status === 'held' && (
        <p>Hold references: {acceptance.hold_ids.join(', ')}</p>
      )}
      {acceptance.status === 'superseded' && (
        <p>
          Replaced by record <code>{acceptance.superseded_by.id}</code>.
        </p>
      )}
      {acceptance.support_revisions
        .filter((support) => support.assignment)
        .map((support) => (
          <p key={support.id}>
            {support.assignment!.role} review/work version{' '}
            {support.assignment!.version}, revision{' '}
            {support.assignment!.revision}.
          </p>
        ))}
      {acceptance.support_revisions
        .filter((support) => support.artifact)
        .map((support) => (
          <p key={support.id}>
            Evidence:{' '}
            <a
              href={`/api/artifacts/${encodeURIComponent(support.artifact!.id)}`}
            >
              {support.artifact!.id}
            </a>{' '}
            version {support.artifact!.version}
          </p>
        ))}
    </div>
  );
}

export function WorldModelStatus({
  state,
}: {
  state: {
    data: WorldTaskResponse | null;
    loading: boolean;
    error: string | null;
  };
}) {
  return (
    <section className={styles.worldPanel} aria-labelledby="world-status-title">
      <h2 id="world-status-title" className={styles.heading}>
        World Model status
      </h2>
      <p className={styles.block}>
        Task completion, independent review, and World Model acceptance are
        separate.
      </p>
      {state.error && (
        <p className={styles.error} role="alert">
          Current World Model status is unavailable: {state.error}
        </p>
      )}
      {!state.error && state.loading && (
        <p className={styles.placeholder} role="status">
          Loading current World Model status...
        </p>
      )}
      {!state.error && !state.loading && state.data?.records.length === 0 && (
        <p className={styles.placeholder} role="status">
          No World Model records are linked to this task.
        </p>
      )}
      {state.data && (
        <>
          {state.data.truncated && (
            <p className={styles.callout}>
              This list is limited to the first 50 linked records.
            </p>
          )}
          <ul className={styles.worldRecords}>
            {state.data.records.map((record) => {
              const acceptance = state.data!.current_acceptances.find(
                (value) => value.subject === record.ref.id,
              )?.acceptance;
              const presentation =
                statusPresentation[acceptance?.status ?? 'none'];
              const limitations = recordLimitations(record);
              return (
                <li key={`${record.ref.id}:${record.ref.revision}`}>
                  <div className={styles.worldRecordHeading}>
                    <h3>{record.kind}</h3>
                    <Badge tone={presentation.tone}>{presentation.label}</Badge>
                  </div>
                  <p className={styles.block}>
                    Scope: {record.scope.workspace}, {record.scope.mode};{' '}
                    producer: {record.producer.kind} {record.producer.id}.
                  </p>
                  {acceptance && <AcceptanceDetails acceptance={acceptance} />}
                  {limitations.length > 0 && (
                    <p>Limitations: {limitations.join('; ')}</p>
                  )}
                  <RecordLineage recordId={record.ref.id} />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
