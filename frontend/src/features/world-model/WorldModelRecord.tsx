import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type {
  WorldAcceptanceOutcome,
  WorldRecord,
} from '../../../../app/contracts/world.ts';
import type {
  WorldRecordDetailResponse,
  WorldRecordReadResponse,
} from '../../../../app/contracts/world-api.ts';
import { readWorldRecord } from './api.ts';
import styles from './WorldModelPage.module.css';

type View = 'overview' | 'relationships' | 'history' | 'lineage';
type Timeline = Extract<
  WorldRecordReadResponse,
  { view: 'history' }
>['history'];
const views: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'relationships', label: 'Relationships' },
  { id: 'history', label: 'History' },
  { id: 'lineage', label: 'Lineage' },
];
const statusLabels: Record<WorldAcceptanceOutcome['status'], string> = {
  accepted: 'Accepted for stated use',
  pending_review: 'Pending review',
  not_eligible: 'Not eligible',
  held: 'Held',
  superseded: 'Superseded',
};

export function recordTitle(record: WorldRecord): string {
  const payload = record.payload;
  if (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload)
  ) {
    for (const key of ['name', 'title', 'location', 'artifact_kind']) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) return value.slice(0, 140);
    }
  }
  return record.external_id ?? record.ref.id;
}

export function WorldModelRecord({
  recordId,
  onSelect,
}: {
  recordId: string;
  onSelect: (id: string) => void;
}) {
  const [detail, setDetail] = useState<WorldRecordDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<View>('overview');
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setDetail(null);
    readWorldRecord(recordId, 'detail', {}, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && result.view === 'detail')
          setDetail(result.detail);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Record detail could not be loaded.',
          );
      });
    return () => controller.abort();
  }, [recordId, attempt]);
  return (
    <section className={styles.inspector} aria-label="Record detail">
      {error ? (
        <div className={styles.error} role="alert">
          <p>{error}</p>
          <button
            type="button"
            className={styles.ghostButton}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry record detail
          </button>
        </div>
      ) : !detail ? (
        <p className={styles.empty} role="status">
          Loading record detail…
        </p>
      ) : (
        <>
          <header className={styles.recordHeading}>
            <p className={styles.eyebrow}>{detail.record.kind}</p>
            <h2>{recordTitle(detail.record)}</h2>
            <p className={styles.recordId}>{detail.record.ref.id}</p>
          </header>
          <nav className={styles.detailTabs} aria-label="Record views">
            {views.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-current={view === item.id ? 'page' : undefined}
                onClick={() => setView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className={styles.recordContent}>
            {view === 'overview' && <RecordOverview detail={detail} />}
            {view === 'relationships' && (
              <div>
                <h3>Connected records</h3>
                {detail.relationships.length === 0 && (
                  <p className={styles.empty}>
                    No relationships are linked to this record.
                  </p>
                )}
                <ul className={styles.relationships}>
                  {detail.relationships.map((edge) => {
                    const outgoing = edge.from.id === recordId;
                    const target = outgoing ? edge.to : edge.from;
                    return (
                      <li key={edge.id}>
                        <span className={styles.recordKind}>
                          {outgoing ? 'Outgoing' : 'Incoming'} · {edge.kind}
                        </span>
                        <button
                          type="button"
                          className={styles.textButton}
                          onClick={() => onSelect(target.id)}
                        >
                          {target.id} <span aria-hidden="true">↗</span>
                        </button>
                        <span className={styles.muted}>
                          Revision {target.revision}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {detail.relationships.length === 100 && (
                  <p className={styles.muted}>
                    Showing up to 100 relationships.
                  </p>
                )}
              </div>
            )}
            {(view === 'history' || view === 'lineage') && (
              <RecordTimeline
                key={recordId + ':' + view}
                recordId={recordId}
                view={view}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function RecordOverview({
  detail,
}: {
  detail: WorldRecordDetailResponse;
}) {
  const record = detail.record;
  const payload = record.payload;
  const taskId =
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    typeof payload.task_id === 'string' &&
    /^[0-9a-f-]{36}$/i.test(payload.task_id)
      ? payload.task_id
      : null;
  return (
    <>
      <section
        className={styles.acceptanceSection}
        aria-label="Current acceptance"
      >
        <h3>Current acceptance</h3>
        {detail.status.acceptances.length === 0 ? (
          <p className={styles.muted}>
            No acceptance decision. A retained record alone does not establish
            review or approval.
          </p>
        ) : (
          detail.status.acceptances.map((outcome) => (
            <div className={styles.acceptance} key={outcome.id}>
              <span className={styles.statusBadge} data-status={outcome.status}>
                {statusLabels[outcome.status]}
              </span>
              <p>
                Stated use: <strong>{outcome.stated_use}</strong>
              </p>
              <p className={styles.muted}>
                Policy {outcome.policy.id} · v{outcome.policy.version}
              </p>
              {'reasons' in outcome && (
                <ul>
                  {outcome.reasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              )}
              {outcome.status === 'held' && (
                <p>Hold references: {outcome.hold_ids.join(', ')}</p>
              )}
              {outcome.status === 'superseded' && (
                <p>
                  Replaced by: <code>{outcome.superseded_by.id}</code>
                </p>
              )}
              {outcome.expires_at && (
                <p className={styles.muted}>
                  Valid until{' '}
                  <time dateTime={outcome.expires_at}>
                    {outcome.expires_at}
                  </time>
                </p>
              )}
            </div>
          ))
        )}
      </section>
      <dl className={styles.metadata}>
        <div>
          <dt>Revision</dt>
          <dd>{record.ref.revision}</dd>
        </div>
        <div>
          <dt>Producer</dt>
          <dd>
            {record.producer.id}
            <span className={styles.muted}> ({record.producer.kind})</span>
          </dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>
            <time dateTime={record.recorded_at}>{record.recorded_at}</time>
          </dd>
        </div>
        {record.observed_at && (
          <div>
            <dt>Observed</dt>
            <dd>
              <time dateTime={record.observed_at}>{record.observed_at}</time>
            </dd>
          </div>
        )}
        {record.retrieved_at && (
          <div>
            <dt>Retrieved</dt>
            <dd>
              <time dateTime={record.retrieved_at}>{record.retrieved_at}</time>
            </dd>
          </div>
        )}
        <div>
          <dt>Content hash</dt>
          <dd className={styles.hash}>{record.ref.sha256}</dd>
        </div>
      </dl>
      <section className={styles.payloadSection}>
        <h3>Retained data</h3>
        <pre className={styles.json}>
          {JSON.stringify(detail.payload, null, 2)}
        </pre>
      </section>
      {detail.support_artifacts.length > 0 && (
        <section className={styles.payloadSection}>
          <h3>Supporting artifacts</h3>
          <ul className={styles.artifactList}>
            {detail.support_artifacts.map((artifact) => (
              <li key={artifact.id + ':' + artifact.version}>
                <a
                  href={'/api/artifacts/' + encodeURIComponent(artifact.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {artifact.id} · v{artifact.version} ↗
                </a>
                <span className={styles.hash}>{artifact.sha256}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {taskId && (
        <p className={styles.taskLink}>
          <Link to={'/task/' + encodeURIComponent(taskId)}>
            Open originating task ↗
          </Link>
          <span className={styles.muted}>
            Review the work or request a correction in its task report.
          </span>
        </p>
      )}
    </>
  );
}

function RecordTimeline({
  recordId,
  view,
}: {
  recordId: string;
  view: 'history' | 'lineage';
}) {
  const [state, setState] = useState<{
    data: Timeline | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });
  const [cursor, setCursor] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    readWorldRecord(
      recordId,
      view,
      { limit: 25, ...(cursor ? { cursor } : {}) },
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted || response.view === 'detail') return;
        const page =
          response.view === 'history' ? response.history : response.lineage;
        setState((current) => ({
          data: {
            ...page,
            schema_version: 'haze.world.history-page.v1',
            entries: cursor
              ? [...(current.data?.entries ?? []), ...page.entries]
              : page.entries,
          },
          loading: false,
          error: null,
        }));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setState((current) => ({
            ...current,
            loading: false,
            error:
              cause instanceof Error
                ? cause.message
                : 'Record history could not be loaded.',
          }));
      });
    return () => controller.abort();
  }, [recordId, view, cursor, attempt]);
  return (
    <section
      aria-label={view === 'history' ? 'Record history' : 'Record lineage'}
    >
      <h3>{view === 'history' ? 'Record history' : 'Support lineage'}</h3>
      <p className={styles.muted}>
        {view === 'history'
          ? 'Saved events for this record, with their original actor and time.'
          : 'Trace the records, reviews and holds that support this work.'}
      </p>
      {state.error && (
        <div role="alert" className={styles.error}>
          <p>{state.error}</p>
          <button
            type="button"
            className={styles.ghostButton}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry history
          </button>
        </div>
      )}
      <ol className={styles.timeline}>
        {state.data?.entries.map((entry) => (
          <li key={entry.event_id}>
            <span className={styles.timelineDot} aria-hidden="true" />
            <strong>{entry.event_kind.replaceAll('_', ' ')}</strong>
            <p className={styles.muted}>
              {entry.actor.id} ·{' '}
              <time dateTime={entry.recorded_at}>{entry.recorded_at}</time>
            </p>
            {entry.record && (
              <p className={styles.recordId}>
                {entry.record.id} · v{entry.record.revision}
              </p>
            )}
            {entry.relationship && (
              <p>
                {entry.relationship.kind}:{' '}
                <code>{entry.relationship.from.id}</code> →{' '}
                <code>{entry.relationship.to.id}</code>
              </p>
            )}
            {entry.acceptance && (
              <p>
                {statusLabels[entry.acceptance.status]} ·{' '}
                {entry.acceptance.stated_use}
              </p>
            )}
            {entry.hold && (
              <p className={styles.holdReason}>{entry.hold.reason}</p>
            )}
            {entry.assessment && <p>Review: {entry.assessment.status}</p>}
          </li>
        ))}
      </ol>
      {state.loading && (
        <p role="status" className={styles.muted}>
          Loading {view}…
        </p>
      )}
      {state.data?.entries.length === 0 && !state.loading && (
        <p className={styles.empty}>No events are available for this record.</p>
      )}
      {state.data?.page.has_more && !state.loading && !state.error && (
        <button
          type="button"
          className={styles.ghostButton}
          onClick={() => setCursor(state.data?.page.next_cursor)}
        >
          Load more events
        </button>
      )}
    </section>
  );
}
