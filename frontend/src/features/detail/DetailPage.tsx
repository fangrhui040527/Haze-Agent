import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLiveData } from '../../app/liveDataContext.ts';
import { dataService } from '../../services/data/index.ts';
import { useNow } from '../../shared/hooks/hooks.ts';
import {
  BAND_STANDARD_LABEL,
  itemBand,
  itemPm25,
} from '../../shared/lib/bands.ts';
import { isAbortError } from '../../shared/lib/delay.ts';
import {
  CATEGORY_LABELS,
  CHECK_RESULT_LABELS,
  EVIDENCE_KIND_LABELS,
  IMPACT_LABELS,
  POLLUTANT_LABELS,
  SOURCE_KIND_LABELS,
} from '../../shared/lib/labels.ts';
import { formatDateTime, utcOffsetLabel } from '../../shared/lib/time.ts';
import { AGENT_INFO } from '../../shared/types/agents.ts';
import type {
  CheckResult,
  ItemDetail,
  ItemSourceRef,
  Location,
  Source,
} from '../../shared/types/domain.ts';
import {
  Badge,
  BandBadge,
  StatusBadge,
  type Tone,
} from '../../shared/ui/Badge.tsx';
import { Button, buttonClass } from '../../shared/ui/Button.tsx';
import { Panel, Skeleton, StateMessage } from '../../shared/ui/States.tsx';
import { TimeAgo } from '../../shared/ui/TimeAgo.tsx';
import { RankBreakdown } from '../live-table/LiveTable.tsx';
import { rankItems } from '../live-table/ranking.ts';
import styles from './DetailPage.module.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'not_found' }
  | { status: 'ready'; detail: ItemDetail };

const CHECK_TONE: Record<CheckResult, Tone> = {
  pass: 'ok',
  warn: 'warn',
  fail: 'error',
  pending: 'neutral',
};
const CHECK_ICON: Record<CheckResult, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✕',
  pending: '…',
};

export function DetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const live = useLiveData();
  const now = useNow(30_000);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    dataService
      .getItem(id, controller.signal)
      .then((detail) =>
        setState(
          detail ? { status: 'ready', detail } : { status: 'not_found' },
        ),
      )
      .catch((error: unknown) => {
        if (!isAbortError(error))
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
      });
    return () => controller.abort();
  }, [id, attempt]);

  const ranked = useMemo(
    () => rankItems(live.items, live.locations, now),
    [live.items, live.locations, now],
  );
  const rankInfo = ranked.find((r) => r.item.id === id) ?? null;
  const liveRevision =
    [...live.items, ...live.pending].find((i) => i.id === id)?.revision ?? null;

  useEffect(() => {
    if (state.status === 'ready')
      document.title = `${state.detail.item.headline} · Haze`;
    return () => {
      document.title = 'Haze';
    };
  }, [state]);

  const back = (
    <Link to="/" className={styles.back}>
      ← Back to dashboard
    </Link>
  );

  if (state.status === 'loading') {
    return (
      <div className={styles.page} aria-busy="true">
        {back}
        <Panel className={styles.block}>
          <Skeleton width="60%" height="28px" />
          <Skeleton width="40%" />
          <Skeleton height="120px" />
        </Panel>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className={styles.page}>
        {back}
        <Panel>
          <StateMessage
            kind="error"
            title="Couldn't load this item."
            action={
              <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
            }
          >
            {state.message}
          </StateMessage>
        </Panel>
      </div>
    );
  }
  if (state.status === 'not_found') {
    return (
      <div className={styles.page}>
        {back}
        <Panel>
          <StateMessage
            kind="empty"
            title="Item not found."
            action={
              <Link to="/" className={buttonClass()}>
                Go to the dashboard
              </Link>
            }
          >
            It may have been removed when the demo data was regenerated.
          </StateMessage>
        </Panel>
      </div>
    );
  }

  const { item, location, sources, related } = state.detail;
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const pm25 = itemPm25(item);
  const band = itemBand(item);
  const passed = item.checks.filter((c) => c.result === 'pass').length;

  const ask = () =>
    navigate('/', {
      state: {
        ask: {
          question: `Tell me more about: "${item.headline}"`,
          focusItemId: item.id,
        },
      },
    });

  return (
    <article className={styles.page}>
      {back}

      {liveRevision !== null && liveRevision > item.revision && (
        <div className={styles.notice} role="status">
          A newer revision (rev {liveRevision}) of this item has arrived.{' '}
          <Button size="small" onClick={() => setAttempt((n) => n + 1)}>
            Load it
          </Button>
        </div>
      )}

      <Panel className={styles.block}>
        <header className={styles.header}>
          <h1 className={styles.headline}>{item.headline}</h1>
          <p className={styles.where}>
            <LocationLine location={location} iso={item.observedAt} />
          </p>
          <div className={styles.badges}>
            <Badge>{CATEGORY_LABELS[item.category]}</Badge>
            <StatusBadge status={item.status} />
            {rankInfo && (
              <Badge tone="accent">
                Rank #{rankInfo.rank} · score {rankInfo.score}
              </Badge>
            )}
            <Badge tone="stale">Revision {item.revision}</Badge>
            {item.fictional && <Badge tone="warn">Fictional sample</Badge>}
            <Button variant="primary" size="small" onClick={ask}>
              Ask the agents about this
            </Button>
          </div>
          <p className={styles.meta}>
            Observed <TimeAgo iso={item.observedAt} /> · record updated{' '}
            <TimeAgo iso={item.updatedAt} />
          </p>
        </header>
      </Panel>

      <div className={styles.twoCol}>
        <Panel className={styles.block}>
          <h2>Summary</h2>
          {item.details.map((p, i) => (
            <p key={i} className={styles.paragraph}>
              {p}
            </p>
          ))}

          <div className={styles.keyNumbers}>
            <h3>Key numbers</h3>
            <p>
              <BandBadge band={band} pm25={pm25} />
            </p>
            <p className={styles.small}>
              {BAND_STANDARD_LABEL}. Local standard:{' '}
              {location?.aqiStandard ?? 'unknown'} (not applied in the demo).
            </p>
            {item.measurements.length > 0 && (
              <table className={styles.numbers}>
                <caption className="visually-hidden">Measurements</caption>
                <thead>
                  <tr>
                    <th scope="col">Pollutant</th>
                    <th scope="col">Value</th>
                    <th scope="col">Averaging</th>
                  </tr>
                </thead>
                <tbody>
                  {item.measurements.map((m) => (
                    <tr key={m.pollutant}>
                      <th scope="row">{POLLUTANT_LABELS[m.pollutant]}</th>
                      <td>
                        {m.value === null ? (
                          <span className={styles.muted}>no data</span>
                        ) : (
                          `${m.value} ${m.unit}`
                        )}
                      </td>
                      <td>{m.averaging}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {item.weather && (
            <dl className={styles.facts}>
              <Fact
                label="Wind"
                value={
                  item.weather.windSpeedKmh === null
                    ? null
                    : `${item.weather.windDirection ?? ''} ${item.weather.windSpeedKmh} km/h`
                }
              />
              <Fact
                label="Visibility"
                value={
                  item.weather.visibilityKm === null
                    ? null
                    : `${item.weather.visibilityKm} km`
                }
              />
              <Fact
                label="Humidity"
                value={
                  item.weather.humidityPct === null
                    ? null
                    : `${item.weather.humidityPct}%`
                }
              />
              <Fact
                label="Rain"
                value={
                  item.weather.rainMm === null
                    ? null
                    : `${item.weather.rainMm} mm`
                }
              />
            </dl>
          )}
          {item.fire && (
            <dl className={styles.facts}>
              <Fact label="Hotspots" value={String(item.fire.hotspotCount)} />
              <Fact
                label="Max fire power"
                value={
                  item.fire.maxFrpMw === null
                    ? null
                    : `${item.fire.maxFrpMw} MW`
                }
              />
              <Fact label="Land type" value={item.fire.landType} />
              <Fact
                label="Detection confidence"
                value={item.fire.detectionConfidence}
              />
            </dl>
          )}
          {item.forecast && (
            <dl className={styles.facts}>
              <Fact label="Direction" value={item.forecast.direction} />
              <Fact
                label="Expected PM2.5"
                value={
                  item.forecast.expectedPm25 === null
                    ? null
                    : `${item.forecast.expectedPm25} µg/m³`
                }
              />
              <Fact
                label="Valid from"
                value={formatDateTime(
                  item.forecast.validFrom,
                  location?.timeZone,
                )}
              />
              <Fact
                label="Valid to"
                value={formatDateTime(
                  item.forecast.validTo,
                  location?.timeZone,
                )}
              />
            </dl>
          )}
          {item.weather && (
            <dl className={styles.facts}>
              <Fact
                label="Temperature"
                value={
                  item.weather.temperatureC === null
                    ? null
                    : `${item.weather.temperatureC} °C`
                }
              />
            </dl>
          )}
          {item.impacts.length > 0 && (
            <>
              <h3>Impacts</h3>
              <ul className={styles.list}>
                {item.impacts.map((impact, i) => (
                  <li key={i}>
                    <strong>{IMPACT_LABELS[impact.kind]}:</strong>{' '}
                    {impact.description}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>

        <Panel className={styles.block}>
          <h2>Why ranked {rankInfo ? `#${rankInfo.rank}` : ''}</h2>
          {rankInfo ? (
            <RankBreakdown parts={rankInfo.parts} score={rankInfo.score} />
          ) : (
            <p className={styles.muted}>
              This item is not in the current live list.
            </p>
          )}
          <p className={styles.small}>
            The ranking rule is documented in{' '}
            <code>src/features/live-table/ranking.ts</code>.
          </p>
        </Panel>
      </div>

      <Panel className={styles.block}>
        <h2>Sources ({item.sources.length})</h2>
        {item.sources.length === 0 ? (
          <p className={styles.muted}>No sources recorded.</p>
        ) : (
          <ol className={styles.sources}>
            {item.sources.map((ref, i) => (
              <SourceEntry
                key={`${ref.sourceId}-${i}`}
                refInfo={ref}
                source={sourceById.get(ref.sourceId) ?? null}
                timeZone={location?.timeZone}
              />
            ))}
          </ol>
        )}
      </Panel>

      <Panel className={styles.block}>
        <h2>
          Evidence checks{' '}
          <span className={styles.muted}>
            (by EvidenceCritic: {passed} of {item.checks.length} passed)
          </span>
        </h2>
        {item.checks.length === 0 ? (
          <p className={styles.muted}>No evidence checks have run yet.</p>
        ) : (
          <ul className={styles.checks}>
            {item.checks.map((c) => (
              <li key={c.id}>
                <Badge tone={CHECK_TONE[c.result]}>
                  <span aria-hidden="true">{CHECK_ICON[c.result]}</span>{' '}
                  {CHECK_RESULT_LABELS[c.result]}
                </Badge>
                <span>
                  <strong>{c.label}.</strong> {c.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel className={styles.block}>
        <h2>Agent results</h2>
        <ul className={styles.agents}>
          {item.agentResults.map((r) => (
            <li key={r.agent}>
              <span
                className={styles.agentName}
                title={AGENT_INFO[r.agent].role}
              >
                {AGENT_INFO[r.agent].name}
              </span>
              <Badge
                tone={
                  r.outcome === 'ok'
                    ? 'ok'
                    : r.outcome === 'warning'
                      ? 'warn'
                      : r.outcome === 'failed'
                        ? 'error'
                        : 'neutral'
                }
              >
                {r.outcome}
              </Badge>
              <span>{r.summary}</span>
              <span className={styles.muted}>
                {(r.durationMs / 1000).toFixed(1)} s
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel className={styles.block}>
        <h2>Timeline</h2>
        <ol className={styles.timeline}>
          {item.timeline.map((t, i) => (
            <li key={i}>
              <time dateTime={t.at} className={styles.time}>
                {formatDateTime(t.at, location?.timeZone)}
              </time>
              <span>
                {t.label}
                {t.agent && (
                  <span className={styles.muted}>
                    {' '}
                    · {AGENT_INFO[t.agent].name}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
        <p className={styles.small}>
          Times shown in the location's local time
          {location
            ? ` (${utcOffsetLabel(item.updatedAt, location.timeZone)})`
            : ''}
          .
        </p>
      </Panel>

      {related.length > 0 && (
        <Panel className={styles.block}>
          <h2>Related items</h2>
          <ul className={styles.list}>
            {related.map((r) => (
              <li key={r.id}>
                <Link to={`/item/${encodeURIComponent(r.id)}`}>
                  {r.headline}
                </Link>{' '}
                <span className={styles.muted}>
                  · {CATEGORY_LABELS[r.category]} ·{' '}
                  <TimeAgo iso={r.updatedAt} />
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </article>
  );
}

function LocationLine({
  location,
  iso,
}: {
  location: Location | null;
  iso: string;
}) {
  if (!location) return <>Unknown location</>;
  return (
    <>
      {location.name}, {location.region}, {location.country} · local{' '}
      {formatDateTime(iso, location.timeZone)} (
      {utcOffsetLabel(iso, location.timeZone)}) · your time{' '}
      {formatDateTime(iso)}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value === null ? <span className={styles.muted}>no data</span> : value}
      </dd>
    </div>
  );
}

function SourceEntry({
  refInfo,
  source,
  timeZone,
}: {
  refInfo: ItemSourceRef;
  source: Source | null;
  timeZone?: string;
}) {
  if (!source) {
    return (
      <li className={styles.source}>
        <p>
          <strong>Source unavailable</strong> <code>{refInfo.sourceId}</code>
        </p>
        <p className={styles.muted}>
          This source is no longer in the source list. {refInfo.excerpt}
        </p>
      </li>
    );
  }
  const time = (label: string, iso: string | null) =>
    iso === null ? null : (
      <span>
        {label} {formatDateTime(iso, timeZone)}
      </span>
    );
  return (
    <li className={styles.source}>
      <p>
        <strong>{source.name}</strong> · {SOURCE_KIND_LABELS[source.kind]} ·{' '}
        <Badge>{EVIDENCE_KIND_LABELS[source.evidenceKind]}</Badge>{' '}
        {refInfo.role !== 'supporting' && (
          <Badge tone={refInfo.role === 'conflicting' ? 'warn' : 'info'}>
            {refInfo.role}
          </Badge>
        )}
      </p>
      <p className={styles.quote}>“{refInfo.excerpt}”</p>
      <p className={styles.sourceTimes}>
        {time('measured', refInfo.measuredAt)}
        {time('published', refInfo.publishedAt)}
        {time('retrieved', refInfo.retrievedAt)}
        {time('valid until', refInfo.validUntil)}
      </p>
      <p className={styles.small}>
        Updates: {source.cadence}. {source.reliabilityNote} {source.licenceNote}{' '}
        <a href={source.url} target="_blank" rel="noreferrer">
          Source page (fictional example link)
        </a>
      </p>
    </li>
  );
}
