import type { ReactNode } from 'react';
import type { TaskRecord } from '../../../../app/contracts/tasks.ts';
import { SmokeLedgerGlobe } from '../chat/SmokeLedgerGlobe.tsx';
import { Badge } from '../../shared/ui/Badge.tsx';
import styles from './SmokeLedgerReport.module.css';

/**
 * A plain-language page for a smoke source trace. Every figure is read from the
 * reviewed trace artifact (its judged findings and map layers); nothing is
 * recomputed or reworded beyond dropping evidence ids, which stay in the
 * technical details below.
 */

type Result = NonNullable<TaskRecord['result']>;

const EVIDENCE = /\s*\[E-[0-9a-f]{10}\]/g;
const plain = (text: string) => text.replace(EVIDENCE, '').trim();
const pct = (x: number) => `${x.toFixed(1)}%`;

interface Area {
  name: string;
  share: number;
  low: number;
  high: number;
  detections: number;
}
interface Hotspot {
  lat: number;
  lon: number;
  share: number;
  detections: number;
  peakFrp: number;
  seen: string;
}
interface Holder {
  name: string;
  share: number;
  low: number;
  high: number;
  detections: number;
}
interface Range {
  central: number;
  low: number;
  high: number;
}
export interface SmokeTrace {
  town: string;
  window: { start: string; end: string } | null;
  live: boolean;
  areas: Area[];
  hotspots: Hotspot[];
  holders: Holder[];
  concession: Range | null;
  peat: Range | null;
  peatIsMinimum: boolean;
  peatMap: string | null;
  air: { mean: number; peak: number } | null;
  confidence: string | null;
  method: string | null;
  limitations: string[];
  assumptions: string[];
  fireCount: number;
  hoursBack: number | null;
  paths: number | null;
  /** Summed weights per wind speed, exactly as the trace recorded them. */
  sums: Sum[];
  settings: Settings | null;
  /** The most heavily weighted fire, factor by factor. */
  example: Example | null;
}
interface Sum {
  scale: number;
  total: number;
  concession: number;
  peat: number;
  concessionPct: number;
  peatPct: number;
}
interface Settings {
  spreadKm: number;
  spreadPerHour: number;
  maxSpreads: number;
  windowHours: number;
  peatWindowHours: number;
  peatFactor: number;
}
interface Example {
  lat: number;
  lon: number;
  frp: number;
  share: number;
  onPeat: boolean;
  weight: number;
  contacts: number;
  peatFactor: number;
  distanceKm: number;
  spaceFactor: number;
  gapHours: number;
  windowHours: number;
  timeFactor: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const range = (value: unknown): Range | null => {
  const r = object(value);
  return r &&
    typeof r.central === 'number' &&
    typeof r.low === 'number' &&
    typeof r.high === 'number'
    ? { central: r.central, low: r.low, high: r.high }
    : null;
};
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/** Reads the reviewed findings by their fixed SmokeLedger openings. */
export function readSmokeTrace(content: unknown): SmokeTrace | null {
  const root = object(content);
  const response = object(root?.response);
  const output = object(response?.output);
  if (!root || !response || !output) return null;
  const map = object(response.map);
  const scope = object(root.scope);
  const window = object(scope?.window);
  const claims = (Array.isArray(output.claims) ? output.claims : [])
    .map((claim) => String(object(claim)?.text ?? ''))
    .filter(Boolean);
  const find = (prefix: string) => claims.find((c) => c.startsWith(prefix));

  const areaClaim = find('Where the smoke-relevant fires were');
  const areas = (areaClaim ? plain(areaClaim).replace(/^[^:]*\):\s*/, '') : '')
    .split(/;\s*/)
    .flatMap((part) => {
      const m =
        /^(.+?) ([\d.]+)% of the smoke signal \(range ([\d.]+)-([\d.]+)%\), (\d+) detections/.exec(
          part,
        );
      return m
        ? [
            {
              name: m[1]![0]!.toUpperCase() + m[1]!.slice(1),
              share: Number(m[2]),
              low: Number(m[3]),
              high: Number(m[4]),
              detections: Number(m[5]),
            },
          ]
        : [];
    })
    .sort((a, b) => b.share - a.share);

  const hotspots = claims.flatMap((claim) => {
    const m =
      /^Fire hotspot centred at (-?[\d.]+), (-?[\d.]+) .*?: ([\d.]+)% of the smoke signal, (\d+) detections, peak FRP ([\d.]+) MW, seen (.+?) UTC to (.+?) UTC/.exec(
        claim,
      );
    return m
      ? [
          {
            lat: Number(m[1]),
            lon: Number(m[2]),
            share: Number(m[3]),
            detections: Number(m[4]),
            peakFrp: Number(m[5]),
            seen: `${shortUtc(m[6]!)} – ${shortUtc(m[7]!)} UTC`,
          },
        ]
      : [];
  });

  const holders = claims.flatMap((claim) => {
    const m =
      /^([^:[]+): ([\d.]+)% \(range ([\d.]+)%-([\d.]+)%\), (\d+) detections/.exec(
        claim,
      );
    return m
      ? [
          {
            name: m[1]!,
            share: Number(m[2]),
            low: Number(m[3]),
            high: Number(m[4]),
            detections: Number(m[5]),
          },
        ]
      : [];
  });

  const peatClaim = find('Fires on peat') ?? '';
  const airClaim = find('Air quality') ?? '';
  const air = /averaged ([\d.]+) ug\/m3 with a peak of ([\d.]+) ug\/m3/.exec(
    airClaim,
  );
  const shares = object(map?.shares);
  const method = object(map?.method);
  return {
    town: typeof scope?.town === 'string' ? scope.town : 'the town',
    window:
      typeof window?.start === 'string' && typeof window.end === 'string'
        ? { start: window.start, end: window.end }
        : null,
    live: response.mode === 'live',
    areas,
    hotspots,
    holders,
    concession: range(shares?.concession),
    peat: range(shares?.peat),
    peatIsMinimum: /minimum/i.test(peatClaim),
    peatMap: /Peat map used: ([^;[]+)/.exec(peatClaim)?.[1]?.trim() ?? null,
    air: air ? { mean: Number(air[1]), peak: Number(air[2]) } : null,
    confidence:
      /^Confidence: (\w+)/.exec(find('Confidence') ?? '')?.[1] ?? null,
    method: (() => {
      const text = find('How each share is calculated');
      return text
        ? plain(text).replace(/^How each share is calculated:\s*/, '')
        : null;
    })(),
    limitations: strings(output.limitations).map(plain),
    assumptions: strings(method?.assumptions),
    fireCount: typeof map?.fire_count === 'number' ? map.fire_count : 0,
    hoursBack:
      typeof method?.hours_back === 'number' ? method.hours_back : null,
    paths:
      typeof method?.paths_per_wind_speed === 'number'
        ? method.paths_per_wind_speed
        : null,
    sums: (Array.isArray(map?.arithmetic) ? map.arithmetic : []).flatMap(
      (row) => {
        const r = object(row);
        const n = (key: string) =>
          typeof r?.[key] === 'number' ? (r[key] as number) : null;
        const scale = n('wind_speed_scale');
        const total = n('total_weight');
        if (scale === null || total === null) return [];
        return [
          {
            scale,
            total,
            concession: n('concession_weight') ?? 0,
            peat: n('peat_weight') ?? 0,
            concessionPct: n('concession_pct') ?? 0,
            peatPct: n('peat_pct') ?? 0,
          },
        ];
      },
    ),
    settings:
      method && typeof method.peat_factor === 'number'
        ? {
            spreadKm: Number(method.spread_km_at_town),
            spreadPerHour: Number(method.spread_km_per_hour_back),
            maxSpreads: Number(method.max_spreads),
            windowHours: Number(method.time_window_hours),
            peatWindowHours: Number(method.peat_time_window_hours),
            peatFactor: method.peat_factor,
          }
        : null,
    example: (() => {
      const fire = object(Array.isArray(map?.fires) ? map.fires[0] : null);
      const why = object(fire?.why);
      const closest = object(why?.closest);
      if (!fire || !why || !closest) return null;
      return {
        lat: Number(fire.lat),
        lon: Number(fire.lon),
        frp: Number(fire.frp),
        share: Number(fire.pct_of_signal),
        onPeat: Boolean(fire.on_peat),
        weight: Number(why.weight),
        contacts: Number(why.contacts),
        peatFactor: Number(why.peat_factor),
        distanceKm: Number(closest.distance_km),
        spaceFactor: Number(closest.space_factor),
        gapHours: Number(closest.gap_hours),
        windowHours: Number(closest.window_hours),
        timeFactor: Number(closest.time_factor),
      };
    })(),
  };
}

const num = (x: number) =>
  x.toLocaleString('en-US', { maximumFractionDigits: 2 });

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
/** "2026-10-22 06:50" → "22 Oct 06:50". */
function shortUtc(text: string) {
  const m = /^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(text);
  return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]} ${m[3]}` : text;
}

/** The window in the town's own calendar days (the end is exclusive). */
export function localDays(window: { start: string; end: string }) {
  const day = (iso: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? { y: +m[1]!, mo: +m[2]!, d: +m[3]! } : null;
  };
  const start = day(window.start);
  const endDay = day(window.end);
  if (!start || !endDay) return `${window.start} to ${window.end}`;
  const midnight = /T00:00(:00)?/.test(window.end);
  const last = new Date(Date.UTC(endDay.y, endDay.mo - 1, endDay.d));
  if (midnight) last.setUTCDate(last.getUTCDate() - 1);
  const fmt = (d: number, mo: number, y?: number) =>
    `${d} ${MONTHS[mo - 1]}${y ? ` ${y}` : ''}`;
  const lastD = last.getUTCDate();
  const lastMo = last.getUTCMonth() + 1;
  const lastY = last.getUTCFullYear();
  if (lastD === start.d && lastMo === start.mo && lastY === start.y)
    return fmt(start.d, start.mo, start.y);
  return lastMo === start.mo && lastY === start.y
    ? `${start.d}–${fmt(lastD, lastMo, lastY)}`
    : `${fmt(start.d, start.mo)} – ${fmt(lastD, lastMo, lastY)}`;
}

const place = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;

function Bar({ value, max }: { value: number; max: number }) {
  return (
    <span className={styles.bar} aria-hidden="true">
      <span style={{ width: `${Math.max(1, (100 * value) / (max || 1))}%` }} />
    </span>
  );
}

function Card({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: ReactNode;
}) {
  return (
    <div className={styles.card}>
      <span className={styles.cardLabel}>{label}</span>
      <strong className={styles.cardValue}>{value}</strong>
      {note && <span className={styles.cardNote}>{note}</span>}
    </div>
  );
}

function ReviewBadge({ status }: { status: Result['review']['status'] }) {
  if (status === 'supported')
    return <Badge tone="ok">✓ Checked by an independent reviewer</Badge>;
  if (status === 'rejected')
    return <Badge tone="error">The reviewer did not accept this result</Badge>;
  return <Badge tone="warn">Not yet independently checked</Badge>;
}

export function SmokeLedgerReport({
  trace,
  content,
  result,
}: {
  trace: SmokeTrace;
  content: unknown;
  result: Result;
}) {
  const main = trace.areas[0];
  const rejected = result.review.status === 'rejected';
  const maxArea = Math.max(0, ...trace.areas.map((a) => a.share));
  const maxHolder = Math.max(0, ...trace.holders.map((h) => h.share));
  const peatWord = trace.peatIsMinimum ? 'at least ' : '';
  return (
    <div className={styles.report}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          Where did the smoke over {trace.town} come from?
        </h1>
        <p className={styles.sub}>
          {trace.window && <span>{localDays(trace.window)} (local time)</span>}
          <ReviewBadge status={result.review.status} />
          {!trace.live && <Badge tone="info">Sample data</Badge>}
        </p>
      </header>

      {main && (
        <section className={styles.answer} aria-label="Short answer">
          <p>
            Most of the smoke came from fires in <b>{main.name}</b> — about{' '}
            <b>{pct(main.share)}</b> of the smoke reaching {trace.town}.
            {trace.concession && (
              <>
                {' '}
                About <b>{pct(trace.concession.central)}</b> came from fires on
                company concession land
              </>
            )}
            {trace.peat && (
              <>
                {trace.concession ? ', and ' : ' '}
                {peatWord}
                <b>{pct(trace.peat.central)}</b> from fires burning on peat
              </>
            )}
            {(trace.concession || trace.peat) && '.'}
          </p>
          {trace.confidence && (
            <p className={styles.muted}>
              Confidence: <b>{trace.confidence}</b> — the answer barely changes
              when the wind speed is varied.
            </p>
          )}
        </section>
      )}

      <div className={styles.cards}>
        {main && (
          <Card
            label="Main source region"
            value={pct(main.share)}
            note={main.name}
          />
        )}
        <Card
          label="From company land"
          value={trace.concession ? pct(trace.concession.central) : '—'}
          note={
            trace.concession
              ? `likely ${pct(trace.concession.low)}–${pct(trace.concession.high)}`
              : 'not assessed (no concession map)'
          }
        />
        <Card
          label="From peat fires"
          value={trace.peat ? `${peatWord}${pct(trace.peat.central)}` : '—'}
          note={
            trace.peat
              ? `likely ${pct(trace.peat.low)}–${pct(trace.peat.high)}`
              : 'not assessed (no peat map)'
          }
        />
        {trace.air && (
          <Card
            label="Air quality in town"
            value={`${trace.air.mean} µg/m³`}
            note={`average PM2.5 · peak ${trace.air.peak} µg/m³`}
          />
        )}
      </div>

      {!rejected && (
        <section aria-labelledby="sl-map">
          <h2 id="sl-map" className={styles.heading}>
            Map: the air&apos;s path and the fires it passed
          </h2>
          <p className={styles.muted}>
            Drag to turn the globe. Blue lines are the air arriving at{' '}
            {trace.town}, traced backwards. Taller columns contributed more
            smoke; click one to see how its share was worked out.
          </p>
          <SmokeLedgerGlobe content={content} />
        </section>
      )}

      {trace.areas.length > 0 && (
        <section aria-labelledby="sl-areas">
          <h2 id="sl-areas" className={styles.heading}>
            Where the fires were
          </h2>
          <ul className={styles.bars}>
            {trace.areas.map((area) => (
              <li key={area.name}>
                <span className={styles.barLabel}>{area.name}</span>
                <Bar value={area.share} max={maxArea} />
                <span className={styles.barValue}>{pct(area.share)}</span>
                <small className={styles.muted}>
                  {area.detections.toLocaleString()} fire detections
                </small>
              </li>
            ))}
          </ul>
          <p className={styles.muted}>
            Regions are approximate boxes, not official province borders.
          </p>
        </section>
      )}

      {trace.hotspots.length > 0 && (
        <section aria-labelledby="sl-hotspots">
          <h2 id="sl-hotspots" className={styles.heading}>
            Biggest fire hotspots
          </h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Location</th>
                  <th scope="col">Share of smoke</th>
                  <th scope="col">Fires seen</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {trace.hotspots.map((h) => (
                  <tr key={`${h.lat},${h.lon}`}>
                    <td>
                      <a
                        href={`https://www.openstreetmap.org/?mlat=${h.lat}&mlon=${h.lon}#map=10/${h.lat}/${h.lon}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {place(h.lat, h.lon)}
                      </a>
                    </td>
                    <td>{pct(h.share)}</td>
                    <td>{h.detections.toLocaleString()}</td>
                    <td>{h.seen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.muted}>
            Each hotspot is an area about 28 km across. Click a location to open
            it on a map.
          </p>
        </section>
      )}

      {trace.holders.length > 0 && (
        <section aria-labelledby="sl-holders">
          <h2 id="sl-holders" className={styles.heading}>
            Company land where fires burned
          </h2>
          <ul className={styles.bars}>
            {trace.holders.map((h) => (
              <li key={h.name}>
                <span className={styles.barLabel}>{h.name}</span>
                <Bar value={h.share} max={maxHolder} />
                <span className={styles.barValue}>{pct(h.share)}</span>
                <small className={styles.muted}>
                  {h.detections.toLocaleString()} fire detections · likely{' '}
                  {pct(h.low)}–{pct(h.high)}
                </small>
              </li>
            ))}
          </ul>
          <p className={styles.callout}>
            A fire inside a concession shows where land burned, not who started
            the fire. These names are leads to check, not findings of fault.
          </p>
        </section>
      )}

      <section aria-labelledby="sl-how">
        <h2 id="sl-how" className={styles.heading}>
          How we worked this out
        </h2>
        <ol className={styles.steps}>
          <li>
            <b>Traced the air backwards.</b> We followed the air arriving at{' '}
            {trace.town} back in time
            {trace.hoursBack ? ` for ${trace.hoursBack} hours` : ''}, along
            {trace.paths ? ` ${trace.paths}` : ' many'} possible paths, and
            repeated it at a slower and a faster wind speed.
          </li>
          <li>
            <b>Found the fires it passed.</b> Satellites spotted{' '}
            {trace.fireCount > 0
              ? `${trace.fireCount.toLocaleString()} fires`
              : 'the fires'}{' '}
            close to those paths at about the right time.
          </li>
          <li>
            <b>Weighed each fire.</b> Bigger fires, fires on peat, and fires
            closer to the air&apos;s path count for more.
          </li>
          <li>
            <b>Added up the shares.</b> A group&apos;s share is its fires&apos;
            weight divided by the weight of all fires.
          </li>
          <li>
            <b>Checked the result.</b> A separate reviewer re-ran every database
            query and checked each sentence against the data.
          </li>
        </ol>
      </section>

      {(trace.sums.length > 0 || trace.settings || trace.method) && (
        <Calculation trace={trace} />
      )}

      {(trace.limitations.length > 0 ||
        trace.assumptions.length > 0 ||
        trace.peatMap) && (
        <section aria-labelledby="sl-limits">
          <h2 id="sl-limits" className={styles.heading}>
            Things to keep in mind
          </h2>
          <ul className={styles.list}>
            {[
              ...trace.limitations,
              ...trace.assumptions,
              ...(trace.peatMap
                ? [
                    `Peat map: ${trace.peatMap}.${trace.peatIsMinimum ? ' It covers only part of the peat, so peat shares are minimums.' : ''}`,
                  ]
                : []),
            ].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The formula, one worked fire, and the exact sums behind every share. */
function Calculation({ trace }: { trace: SmokeTrace }) {
  const { settings, example, sums } = trace;
  const headline = sums.find((row) => row.scale === 1);
  return (
    <section aria-labelledby="sl-calc">
      <h2 id="sl-calc" className={styles.heading}>
        How the percentages were calculated
      </h2>
      <p className={styles.formula}>
        fire weight = fire strength (FRP) × peat factor × distance factor × time
        factor
        <br />
        share = weight of a group&apos;s fires ÷ weight of all fires
      </p>
      {settings && (
        <ul className={styles.list}>
          <li>
            <b>Fire strength (FRP)</b>: the heat the satellite measured, in
            megawatts. Bigger fires make more smoke.
          </li>
          <li>
            <b>Peat factor</b>: ×{settings.peatFactor} if the fire is on peat
            (peat smoulders and smokes more), otherwise ×1. This value is an
            assumption, not a measurement.
          </li>
          <li>
            <b>Distance factor</b>: 1 when the air passed right over the fire,
            falling towards 0 further away. The allowed distance is{' '}
            {settings.spreadKm} km at the town, widening by{' '}
            {settings.spreadPerHour} km for each hour further back; fires more
            than {settings.maxSpreads}× that away are not counted.
          </li>
          <li>
            <b>Time factor</b>: 1 when the fire was seen exactly when the air
            passed, falling to 0 at {settings.windowHours} hours apart (
            {settings.peatWindowHours} hours for peat, which burns longer).
          </li>
          <li>
            A fire&apos;s weight is added up over every air path that passed it,
            then divided by the number of paths.
          </li>
        </ul>
      )}

      {example && (
        <>
          <h3 className={styles.subheading}>
            Example: the biggest single contributor
          </h3>
          <p>
            A fire at {place(example.lat, example.lon)}
            {example.onPeat ? ' on peat' : ''}:
          </p>
          <p className={styles.formula}>
            {num(example.frp)} MW × {example.peatFactor} (peat) ×{' '}
            {example.spaceFactor} (air passed {example.distanceKm} km away) ×{' '}
            {example.timeFactor} (seen {example.gapHours} h apart, within{' '}
            {example.windowHours} h)
            <br />
            added over {example.contacts.toLocaleString()} air paths → weight{' '}
            <b>{num(example.weight)}</b>
            {headline && (
              <>
                <br />
                {num(example.weight)} ÷ {num(headline.total)} (all fires) ={' '}
                <b>{example.share}%</b> of the smoke
              </>
            )}
          </p>
        </>
      )}

      {sums.length > 0 && (
        <>
          <h3 className={styles.subheading}>The actual sums</h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Wind speed</th>
                  <th scope="col">Company land</th>
                  <th scope="col">Peat</th>
                </tr>
              </thead>
              <tbody>
                {sums.map((row) => (
                  <tr
                    key={row.scale}
                    className={row.scale === 1 ? styles.headline : undefined}
                  >
                    <td>
                      {row.scale === 1
                        ? 'As measured (headline)'
                        : row.scale < 1
                          ? `${Math.round((1 - row.scale) * 100)}% slower`
                          : `${Math.round((row.scale - 1) * 100)}% faster`}
                    </td>
                    <td>
                      {num(row.concession)} ÷ {num(row.total)} ={' '}
                      <b>{row.concessionPct}%</b>
                    </td>
                    <td>
                      {num(row.peat)} ÷ {num(row.total)} = <b>{row.peatPct}%</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.muted}>
            The headline percentage uses the measured wind; the
            &ldquo;likely&rdquo; range is the lowest and highest of the three
            rows. Winds are never known exactly, so a narrow range means the
            answer is robust.
          </p>
        </>
      )}

      {trace.method && (
        <details className={styles.more}>
          <summary>Show the formula as the engine states it</summary>
          <p>{trace.method}</p>
        </details>
      )}
    </section>
  );
}
