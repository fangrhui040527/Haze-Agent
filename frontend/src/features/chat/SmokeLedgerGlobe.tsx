import { useEffect, useMemo, useRef, useState } from 'react';
import type { GlobeInstance } from 'globe.gl';
import type { ArtifactRef } from '../../../../app/contracts/artifacts.ts';
import { agentService } from '../../services/agents/index.ts';
import styles from './SmokeLedgerGlobe.module.css';

interface Range {
  central: number;
  low: number;
  high: number;
}
interface Fire {
  lat: number;
  lon: number;
  pct_of_signal: number;
  frp: number;
  on_peat: boolean;
  in_concession: boolean;
  /** How the fire earned its weight at the central wind speed (absent in older traces). */
  why?: {
    weight: number;
    contacts: number;
    peat_factor: number;
    closest: {
      distance_km: number;
      spread_km: number;
      gap_hours: number;
      window_hours: number;
      hours_back: number;
      space_factor: number;
      time_factor: number;
    };
  } | null;
}
interface Method {
  paths_per_wind_speed: number;
  hours_back: number;
  wind_scales: number[];
  spread_km_at_town: number;
  spread_km_per_hour_back: number;
  max_spreads: number;
  time_window_hours: number;
  peat_time_window_hours: number;
  peat_factor: number;
  assumptions: string[];
}
interface Arithmetic {
  wind_speed_scale: number;
  total_weight: number;
  concession_weight: number;
  peat_weight: number;
  concession_pct: number;
  peat_pct: number;
}
interface ConcessionProperties {
  concession_id: string;
  name: string | null;
  company: string | null;
  group_name: string | null;
  map_source: string | null;
  map_date: string | null;
  fires: number;
  weight?: number;
  pct_of_signal: number;
}
interface Concession {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: ConcessionProperties;
}
interface MapLayers {
  backward_run_id: string;
  town: { name: string; lat: number; lon: number } | null;
  paths: [number, number][][];
  fires: Fire[];
  fire_count: number;
  shares: { concession: Range | null; peat: Range | null };
  total_weight?: number;
  method?: Method;
  arithmetic?: Arithmetic[];
  concessions: { features: Concession[] };
  note: string;
}
interface Trace {
  layers: MapLayers;
  window: { start: string; end: string } | null;
  live: boolean;
  /** Evidence ids cited by the concession, peat and area findings. */
  cites: { concession?: string; peat?: string };
}

// Pinned to the three-globe version globe.gl 2.46.1 installs.
const IMG = 'https://unpkg.com/three-globe@2.45.6/example/img';
const COLOR = {
  peat: '#e4572e',
  concession: '#f2b134',
  other: '#f6e3a1',
  path: '#7dd3fc',
};
const LAYERS = ['Fires', 'Air paths', 'Concessions'] as const;
type LayerName = (typeof LAYERS)[number];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function traceOf(content: unknown): Trace | null {
  const root = object(content);
  const response = object(root?.response);
  const map = object(response?.map);
  if (!map || !Array.isArray(map.paths) || !Array.isArray(map.fires))
    return null;
  const window = object(object(root?.scope)?.window);
  const claims = Array.isArray(object(response?.output)?.claims)
    ? (object(response?.output)!.claims as { text?: unknown }[])
    : [];
  const cite = (prefix: string) => {
    const text = claims
      .map((claim) => String(claim.text ?? ''))
      .find((line) => line.startsWith(prefix));
    return /\[(E-[0-9a-f]{10})\]/.exec(text ?? '')?.[1];
  };
  return {
    layers: map as unknown as MapLayers,
    window:
      window &&
      typeof window.start === 'string' &&
      typeof window.end === 'string'
        ? { start: window.start, end: window.end }
        : null,
    live: response?.mode === 'live',
    cites: {
      concession: cite('Fires inside mapped concessions'),
      peat: cite('Fires on peat'),
    },
  };
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const fireColor = (fire: Fire) =>
  fire.on_peat
    ? COLOR.peat
    : fire.in_concession
      ? COLOR.concession
      : COLOR.other;
const utc = (iso: string) =>
  `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The exact, hash-checked source-trace artifact among a result's work products. */
export function useSmokeLedgerTrace(products: ArtifactRef[]): unknown {
  const [content, setContent] = useState<unknown>(null);
  useEffect(() => {
    if (!agentService.readArtifact || !products.length) return;
    const controller = new AbortController();
    void (async () => {
      for (const product of products) {
        const artifact = await agentService.readArtifact!(
          product.id,
          controller.signal,
        ).catch(() => null);
        if (
          !artifact ||
          artifact.version !== product.version ||
          artifact.sha256 !== product.sha256 ||
          artifact.kind !== 'smokeledger.trace_sources'
        )
          continue;
        if (!controller.signal.aborted) setContent(artifact.content);
        return;
      }
    })();
    return () => controller.abort();
  }, [products]);
  return content;
}

/**
 * Where the air over the town came from, on a 3D globe: weighted fires as columns,
 * the backward air paths, and the concessions those fires were in. Drawn only from
 * the exact, hash-checked source-trace work product of a non-rejected result.
 */
export function SmokeLedgerGlobe({
  products = [],
  content,
}: {
  products?: ArtifactRef[];
  /** An already loaded trace artifact's content; skips loading `products`. */
  content?: unknown;
}) {
  const loaded = useSmokeLedgerTrace(content === undefined ? products : []);
  const source = content === undefined ? loaded : content;
  const trace = useMemo(() => traceOf(source), [source]);
  const [hidden, setHidden] = useState<Set<LayerName>>(new Set());
  const [picked, setPicked] = useState<Fire | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const globe = useRef<GlobeInstance | null>(null);

  const home = () => {
    const town = trace?.layers.town;
    if (town)
      globe.current?.pointOfView(
        { lat: town.lat - 3, lng: town.lon, altitude: 1.1 },
        1200,
      );
  };

  useEffect(() => {
    const element = container.current;
    if (!trace || !element) return;
    let disposed = false;
    // Loaded on demand: WebGL needs a browser window.
    void import('globe.gl').then(({ default: Globe }) => {
      if (disposed) return;
      const { layers } = trace;
      const largest = Math.max(
        0.01,
        ...layers.fires.map((f) => f.pct_of_signal),
      );
      const instance = new Globe(element)
        .width(element.clientWidth)
        .height(element.clientHeight)
        .globeImageUrl(`${IMG}/earth-day.jpg`)
        .bumpImageUrl(`${IMG}/earth-topology.png`)
        .backgroundImageUrl(`${IMG}/night-sky.png`)
        .atmosphereColor('#f08a3c')
        .atmosphereAltitude(0.12)
        .pointLat('lat')
        .pointLng('lon')
        .pointRadius(0.12)
        .pointAltitude(
          (d) => 0.005 + 0.25 * ((d as Fire).pct_of_signal / largest),
        )
        .pointColor((d) => fireColor(d as Fire))
        .pointLabel((d) => {
          const fire = d as Fire;
          return `<b>${fire.on_peat ? 'Fire on peat' : fire.in_concession ? 'Fire on concession land' : 'Fire'}</b><br>${fire.pct_of_signal}% of the smoke signal · FRP ${fire.frp} MW<br><i>Click to see how it was weighted</i>`;
        })
        .onPointClick((d) => setPicked(d as Fire))
        .pathPoints((p) => p as [number, number][])
        .pathPointLat((p) => (p as [number, number])[0])
        .pathPointLng((p) => (p as [number, number])[1])
        .pathPointAlt(0.01)
        .pathColor(() => COLOR.path)
        .pathStroke(1.2)
        .pathDashLength(0.08)
        .pathDashGap(0.02)
        .pathDashAnimateTime(6000)
        .polygonCapColor(() => 'rgba(242, 177, 52, 0.35)')
        .polygonSideColor(() => 'rgba(242, 177, 52, 0.2)')
        .polygonStrokeColor(() => '#f2b134')
        .polygonAltitude(0.006)
        .polygonLabel((d) => {
          const p = (d as Concession).properties;
          return (
            `<b>${escape(p.name ?? p.concession_id)}</b><br>` +
            `Company: ${escape(p.company ?? 'not listed')} · Group: ${escape(p.group_name ?? 'not listed')}<br>` +
            `${p.fires} detections · ${p.pct_of_signal}% of the smoke signal<br>` +
            `<i>Lead for verification: shows where land burned, not who lit it.</i><br>` +
            `Boundary: ${escape(p.map_source ?? 'unknown')}, ${escape(p.map_date ?? 'date unknown')}`
          );
        })
        .labelLat('lat')
        .labelLng('lon')
        .labelText('name')
        .labelSize(1.1)
        .labelDotRadius(0.5)
        .labelColor(() => '#fff4e0')
        .labelsData(layers.town ? [layers.town] : []);
      // The orange tint of the reference view: multiply the day texture.
      (
        instance.globeMaterial() as { color?: { set(c: string): void } }
      ).color?.set('#f0a060');
      globe.current = instance;
      const town = layers.town;
      if (town)
        instance.pointOfView({
          lat: town.lat - 3,
          lng: town.lon,
          altitude: 1.1,
        });
      setHidden(new Set());
    });
    return () => {
      disposed = true;
      globe.current?._destructor();
      globe.current = null;
      element.replaceChildren();
    };
  }, [trace]);

  // Layer toggles only swap data, so the camera stays where the viewer left it.
  useEffect(() => {
    const instance = globe.current;
    if (!instance || !trace) return;
    const { layers } = trace;
    instance
      .pointsData(hidden.has('Fires') ? [] : layers.fires)
      .pathsData(hidden.has('Air paths') ? [] : layers.paths)
      .polygonsData(
        hidden.has('Concessions') ? [] : layers.concessions.features,
      );
  }, [hidden, trace]);

  if (!trace) return null;
  const { layers, window, cites } = trace;
  const share = (range: Range | null, label: string, cite?: string) => (
    <div className={styles.stat}>
      <strong>{range ? `${range.central.toFixed(1)}%` : '—'}</strong>
      <span>
        {range
          ? `from fires ${label} (range ${range.low.toFixed(1)}%–${range.high.toFixed(1)}%)`
          : `fires ${label}: not assessed, no map loaded`}
      </span>
      {cite && <code>{cite}</code>}
    </div>
  );
  const top = [...layers.concessions.features]
    .map((f) => f.properties)
    .sort((a, b) => b.pct_of_signal - a.pct_of_signal)
    .slice(0, 5);
  const maxTop = Math.max(0.1, ...top.map((t) => t.pct_of_signal));
  const toggle = (name: LayerName) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <section aria-label="Smoke source globe" className={styles.wrap}>
      <div ref={container} className={styles.globe} />
      <aside className={styles.panel}>
        <span className={styles.badge}>
          {trace.live ? 'Live data · reviewed trace' : 'Sample data'}
        </span>
        <h3>
          Where did {layers.town?.name ?? 'the town'}&apos;s smoke come from?
        </h3>
        <p className={styles.meta}>
          {window ? `${utc(window.start)} to ${utc(window.end)}` : ''} · run{' '}
          <code>{layers.backward_run_id}</code>
        </p>
        <div className={styles.stats}>
          {share(
            layers.shares.concession,
            'on concession land',
            cites.concession,
          )}
          {share(layers.shares.peat, 'on mapped peat', cites.peat)}
        </div>
        <p className={styles.meta}>
          {layers.fire_count.toLocaleString()} fires on the air&apos;s path (the{' '}
          {layers.fires.length} most weighted are drawn)
        </p>
        {picked && (
          <FireBreakdown
            fire={picked}
            total={layers.total_weight}
            onClose={() => setPicked(null)}
          />
        )}
        {layers.method && layers.arithmetic && (
          <Calculation
            method={layers.method}
            arithmetic={layers.arithmetic}
            town={layers.town?.name ?? 'the town'}
            cites={cites}
          />
        )}
        {top.length > 0 && (
          <>
            <h4>Top concessions by share</h4>
            <ul className={styles.concessions}>
              {top.map((c) => (
                <li key={c.concession_id}>
                  <div className={styles.row}>
                    <span>{c.name ?? c.concession_id}</span>
                    <span>{c.pct_of_signal.toFixed(1)}%</span>
                  </div>
                  <div className={styles.bar}>
                    <div
                      style={{ width: `${(100 * c.pct_of_signal) / maxTop}%` }}
                    />
                  </div>
                  <small>
                    {c.group_name ?? 'group not listed'} · {c.fires} fires ·
                    map: {c.map_source ?? 'unknown'},{' '}
                    {c.map_date ?? 'date unknown'}
                    {c.weight !== undefined && layers.total_weight
                      ? ` · weight ${num(c.weight)} ÷ total ${num(layers.total_weight)}`
                      : ''}
                  </small>
                </li>
              ))}
            </ul>
          </>
        )}
        <h4>Legend</h4>
        <p className={styles.legend}>
          <i style={{ background: COLOR.peat }} /> fire on peat{' '}
          <i style={{ background: COLOR.concession }} /> fire on concession{' '}
          <i style={{ background: COLOR.other }} /> other fire{' '}
          <i style={{ background: COLOR.path }} /> air path to town
        </p>
        <div className={styles.buttons}>
          {LAYERS.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={!hidden.has(name)}
              onClick={() => toggle(name)}
            >
              {name}
            </button>
          ))}
          <button type="button" onClick={home}>
            Reset view
          </button>
        </div>
        <p className={styles.note}>
          Column height = each fire&apos;s share of the attributed smoke. Fires
          inside a concession show where land burned, not who lit it: names are
          leads for verification. Concession and peat boundaries come from
          public maps that may be outdated or partial. Air paths use
          SmokeLedger&apos;s simple trajectory model, not HYSPLIT.
        </p>
      </aside>
    </section>
  );
}

const num = (x: number) =>
  x.toLocaleString(undefined, { maximumFractionDigits: x < 10 ? 3 : 1 });

/** One fire's weight, factor by factor, as the engine computed it. */
function FireBreakdown({
  fire,
  total,
  onClose,
}: {
  fire: Fire;
  total?: number;
  onClose: () => void;
}) {
  const why = fire.why;
  return (
    <div className={styles.explain} role="region" aria-label="Selected fire">
      <div className={styles.row}>
        <h4>Selected fire</h4>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <p>
        {fire.on_peat
          ? 'On mapped peat'
          : fire.in_concession
            ? 'On concession land'
            : 'Not on mapped peat or concession land'}{' '}
        · {fire.lat.toFixed(3)}, {fire.lon.toFixed(3)}
      </p>
      {why ? (
        <>
          <p>
            Each time the air passed this fire it added{' '}
            <b>fire strength × peat factor × distance factor × time factor</b>{' '}
            (÷ the number of air paths). At its closest pass:
          </p>
          <ul className={styles.factors}>
            <li>
              Fire strength (FRP): <b>{fire.frp} MW</b>
            </li>
            <li>
              Peat factor: <b>×{why.peat_factor}</b>
              {why.peat_factor > 1
                ? ' (on peat; an assumption)'
                : ' (not on peat)'}
            </li>
            <li>
              Distance factor: <b>×{why.closest.space_factor}</b> — the air
              passed {why.closest.distance_km} km away; the path&apos;s spread
              there was {why.closest.spread_km} km ({why.closest.hours_back} h
              before reaching the town)
            </li>
            <li>
              Time factor: <b>×{why.closest.time_factor}</b> — seen{' '}
              {why.closest.gap_hours} h from the air passing, within a{' '}
              {why.closest.window_hours} h window
            </li>
          </ul>
          <p>
            Added over <b>{why.contacts}</b> passes, its weight is{' '}
            <b>{num(why.weight)}</b>
            {total ? (
              <>
                {' '}
                ÷ all fires&apos; {num(total)} ={' '}
                <b>{fire.pct_of_signal}% of the smoke signal</b>
              </>
            ) : null}
            .
          </p>
        </>
      ) : (
        <p>
          {fire.pct_of_signal}% of the smoke signal. This trace predates the
          per-fire breakdown; re-run the question to see each factor.
        </p>
      )}
    </div>
  );
}

/** The method, the settings and the exact sums behind every share. */
function Calculation({
  method,
  arithmetic,
  town,
  cites,
}: {
  method: Method;
  arithmetic: Arithmetic[];
  town: string;
  cites: Trace['cites'];
}) {
  return (
    <details className={styles.explain}>
      <summary>How these numbers were calculated</summary>
      <ol className={styles.steps}>
        <li>
          <b>Trace the air backwards.</b> {method.paths_per_wind_speed} air
          paths are followed {method.hours_back} h back from {town}, then
          repeated with wind speeds ×{method.wind_scales.join(', ×')}.
        </li>
        <li>
          <b>Find the fires the air passed.</b> A satellite fire counts if a
          path came within {method.max_spreads} spreads of it (spread ={' '}
          {method.spread_km_at_town} km + {method.spread_km_per_hour_back} km
          per hour back) and it was seen within {method.time_window_hours} h (
          {method.peat_time_window_hours} h on peat).
        </li>
        <li>
          <b>Weigh each fire.</b> fire strength (FRP) × peat factor (
          {method.peat_factor} on peat, else 1) × distance factor e
          <sup>−d²/2σ²</sup> × time factor (1 − gap ÷ window), added over every
          pass and divided by the number of paths. Click any fire column to see
          its numbers.
        </li>
        <li>
          <b>Add up the shares.</b> share = summed weight of the fires in a
          group ÷ summed weight of all fires on the path.
        </li>
      </ol>
      <table className={styles.sums}>
        <thead>
          <tr>
            <th>Wind speed</th>
            <th>Concession ÷ total</th>
            <th>Share</th>
            <th>Peat ÷ total</th>
            <th>Share</th>
          </tr>
        </thead>
        <tbody>
          {arithmetic.map((a) => (
            <tr
              key={a.wind_speed_scale}
              className={a.wind_speed_scale === 1 ? styles.central : undefined}
            >
              <td>×{a.wind_speed_scale}</td>
              <td>
                {num(a.concession_weight)} ÷ {num(a.total_weight)}
              </td>
              <td>{a.concession_pct}%</td>
              <td>
                {num(a.peat_weight)} ÷ {num(a.total_weight)}
              </td>
              <td>{a.peat_pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        The headline share is the ×1 row; the range is the lowest and highest
        row. A narrow range means the answer barely depends on the uncertain
        wind speed.
        {cites.concession || cites.peat ? (
          <>
            {' '}
            The same sums are in the cited query{' '}
            <code>{cites.concession ?? cites.peat}</code>, which EvidenceCritic
            re-ran before the answer was accepted.
          </>
        ) : null}
      </p>
      <h4>Assumptions</h4>
      <ul className={styles.factors}>
        {method.assumptions.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
    </details>
  );
}
