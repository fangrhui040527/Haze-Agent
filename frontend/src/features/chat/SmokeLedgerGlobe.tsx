import { useEffect, useRef, useState } from 'react';
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
}
interface ConcessionProperties {
  concession_id: string;
  name: string | null;
  company: string | null;
  group_name: string | null;
  map_source: string | null;
  map_date: string | null;
  fires: number;
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

/**
 * Where the air over the town came from, on a 3D globe: weighted fires as columns,
 * the backward air paths, and the concessions those fires were in. Drawn only from
 * the exact, hash-checked source-trace work product of a non-rejected result.
 */
export function SmokeLedgerGlobe({ products }: { products: ArtifactRef[] }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [hidden, setHidden] = useState<Set<LayerName>>(new Set());
  const container = useRef<HTMLDivElement>(null);
  const globe = useRef<GlobeInstance | null>(null);

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
        const found = traceOf(artifact.content);
        if (found && !controller.signal.aborted) {
          setTrace(found);
          return;
        }
      }
    })();
    return () => controller.abort();
  }, [products]);

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
          return `<b>${fire.on_peat ? 'Fire on peat' : fire.in_concession ? 'Fire on concession land' : 'Fire'}</b><br>${fire.pct_of_signal}% of the smoke signal · FRP ${fire.frp} MW`;
        })
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
