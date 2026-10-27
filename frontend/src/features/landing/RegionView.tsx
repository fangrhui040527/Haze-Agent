import { Suspense, lazy, useId, useMemo, useState } from 'react';
import { Globe2, Hand, Map as MapIcon, RotateCcw } from 'lucide-react';
import {
  AQI_BANDS,
  SATELLITE_LAYERS,
  aqiBand,
  compass,
  type CityReading,
  type FireResult,
  type SatelliteLayerId,
} from '../../shared/data/airQuality.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { Spinner } from '../../shared/ui/States.tsx';
import {
  CO_BREAKS,
  DEFAULT_LAYERS,
  TEMP_BREAKS,
  prefersFlatMap,
  type LayerState,
  type PrimaryLayer,
} from './regionLayers.ts';
import styles from './RegionView.module.css';

const RegionGlobe = lazy(() => import('./RegionGlobe.tsx'));
const RegionMap = lazy(() => import('./RegionMap.tsx'));

const PRIMARY: { id: PrimaryLayer; label: string }[] = [
  { id: 'aqi', label: 'PM2.5 · US AQI' },
  { id: 'co', label: 'Carbon monoxide' },
  { id: 'temp', label: 'Temperature' },
];

function isCoarsePointer() {
  return window.matchMedia('(pointer: coarse)').matches;
}

export function RegionView({
  readings,
  fires,
  selectedId,
  onSelect,
}: {
  readings: CityReading[];
  fires: FireResult | null;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [mode, setMode] = useState<'globe' | 'map'>(() =>
    prefersFlatMap() ? 'map' : 'globe',
  );
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS);
  const [resetKey, setResetKey] = useState(0);
  const [interactive, setInteractive] = useState(() => !isCoarsePointer());
  const tableId = useId();
  const satellite = SATELLITE_LAYERS.find((l) => l.id === layers.satellite) ?? null;
  // Freeze "now" per selection so the image URL (and its cache) stays stable.
  const satelliteTime = useMemo(
    () => (satellite ? satellite.time(new Date()) : null),
    [satellite],
  );
  const firesAvailable = fires?.status === 'ok';

  const View = mode === 'globe' ? RegionGlobe : RegionMap;

  return (
    <div className={styles.wrap}>
      <div
        className={`${styles.stage} ${interactive ? '' : styles.locked}`}
        role="region"
        aria-label={
          mode === 'globe'
            ? '3D globe of Malaysia, Singapore and Indonesia with live haze readings'
            : 'Map of Malaysia, Singapore and Indonesia with live haze readings'
        }
        aria-describedby={tableId}
      >
        <Suspense
          fallback={
            <div className={styles.loading}>
              <Spinner /> Loading {mode === 'globe' ? 'globe' : 'map'}…
            </div>
          }
        >
          <View
            readings={readings}
            fires={fires}
            layers={layers}
            selectedId={selectedId}
            onSelect={onSelect}
            resetKey={resetKey}
            satelliteTime={satelliteTime}
          />
        </Suspense>

        {!interactive && (
          <button
            type="button"
            className={styles.tapCover}
            onClick={() => setInteractive(true)}
          >
            <Hand size={18} aria-hidden="true" /> Tap to interact
          </button>
        )}

        <div className={styles.stageControls}>
          <Button size="small" onClick={() => setResetKey((k) => k + 1)}>
            <RotateCcw size={14} aria-hidden="true" /> Reset to Malaysia
          </Button>
          <Button
            size="small"
            onClick={() => setMode((m) => (m === 'globe' ? 'map' : 'globe'))}
          >
            {mode === 'globe' ? (
              <>
                <MapIcon size={14} aria-hidden="true" /> Flat map
              </>
            ) : (
              <>
                <Globe2 size={14} aria-hidden="true" /> 3D globe
              </>
            )}
          </Button>
          {interactive && isCoarsePointer() && (
            <Button size="small" onClick={() => setInteractive(false)}>
              Done
            </Button>
          )}
        </div>
      </div>

      <div className={styles.chips}>
        <fieldset className={styles.chipGroup}>
          <legend>Points</legend>
          {PRIMARY.map((p) => (
            <label key={p.id} className={styles.chip}>
              <input
                type="radio"
                name="primary-layer"
                checked={layers.primary === p.id}
                onChange={() => setLayers((l) => ({ ...l, primary: p.id }))}
              />
              {p.label}
            </label>
          ))}
        </fieldset>
        <fieldset className={styles.chipGroup}>
          <legend>Overlays</legend>
          <label className={styles.chip}>
            <input
              type="checkbox"
              checked={layers.wind}
              onChange={(e) => setLayers((l) => ({ ...l, wind: e.target.checked }))}
            />
            Wind
          </label>
          <label className={styles.chip}>
            <input
              type="checkbox"
              checked={layers.fires && firesAvailable}
              disabled={!firesAvailable}
              onChange={(e) => setLayers((l) => ({ ...l, fires: e.target.checked }))}
            />
            Fire hotspots
          </label>
          {SATELLITE_LAYERS.map((s) => (
            <label key={s.id} className={styles.chip}>
              <input
                type="checkbox"
                checked={layers.satellite === s.id}
                onChange={(e) =>
                  setLayers((l) => ({
                    ...l,
                    satellite: e.target.checked ? (s.id as SatelliteLayerId) : null,
                  }))
                }
              />
              {s.label}
            </label>
          ))}
        </fieldset>
      </div>

      <Legend
        primary={layers.primary}
        fires={fires}
        satellite={satellite}
        satelliteTime={satelliteTime}
      />

      <details className={styles.tableWrap}>
        <summary>Readings as a table</summary>
        <ReadingsTable id={tableId} readings={readings} />
      </details>
    </div>
  );
}

function Legend({
  primary,
  fires,
  satellite,
  satelliteTime,
}: {
  primary: PrimaryLayer;
  fires: FireResult | null;
  satellite: (typeof SATELLITE_LAYERS)[number] | null;
  satelliteTime: string | null;
}) {
  return (
    <div className={styles.legend}>
      {primary === 'aqi' && (
        <ul className={styles.scale} aria-label="US AQI bands">
          {AQI_BANDS.map((b) => (
            <li key={b.id}>
              <span
                className={styles.scaleSwatch}
                style={{ background: `var(--band-${b.cssVar})` }}
                aria-hidden="true"
              />
              {b.label}
            </li>
          ))}
        </ul>
      )}
      {primary === 'co' && (
        <ul className={styles.scale} aria-label="Carbon monoxide, µg/m³">
          {[0, ...CO_BREAKS].map((b, i, all) => (
            <li key={b}>
              <span
                className={styles.scaleSwatch}
                style={{ background: `var(--scale-co-${i + 1})` }}
                aria-hidden="true"
              />
              {i === all.length - 1 ? `≥ ${b}` : `${b}–${all[i + 1]}`} µg/m³
            </li>
          ))}
        </ul>
      )}
      {primary === 'temp' && (
        <ul className={styles.scale} aria-label="Temperature at 2 m, °C">
          {[0, ...TEMP_BREAKS].map((b, i, all) => (
            <li key={b}>
              <span
                className={styles.scaleSwatch}
                style={{ background: `var(--scale-temp-${i + 1})` }}
                aria-hidden="true"
              />
              {i === 0 ? `< ${all[1]}` : i === all.length - 1 ? `≥ ${b}` : `${b}–${all[i + 1]}`} °C
            </li>
          ))}
        </ul>
      )}
      <p className={styles.legendNote}>
        PM2.5 is the primary haze indicator. CO is a combustion tracer for fire
        smoke, not an air-quality index. Point values are{' '}
        <strong>modelled by CAMS via Open-Meteo</strong>, not ground sensors.
      </p>
      {satellite && satelliteTime && (
        <p className={styles.legendNote}>
          <strong>Satellite · {satellite.label}</strong>: observed{' '}
          <span className="num">{satellite.timeLabel(satelliteTime)}</span>.{' '}
          {satellite.note}
        </p>
      )}
      <p className={styles.legendNote}>
        {fires?.status === 'ok' && (
          <>
            Fire hotspots: <span className="num">{fires.hotspots.length}</span>{' '}
            satellite detections in 48 h ({fires.source}).{' '}
          </>
        )}
        {fires?.status === 'no-key' && <>Fire layer needs a FIRMS key. </>}
        {fires?.status === 'error' && <>Fire layer unavailable: {fires.message}. </>}
        Wind arrows point where air is moving to.
      </p>
      <p className={styles.credits}>
        Data: Open-Meteo.com (CC BY 4.0) · CAMS, Copernicus · NASA GIBS and
        FIRMS, NASA EOSDIS
      </p>
    </div>
  );
}

function ReadingsTable({ id, readings }: { id: string; readings: CityReading[] }) {
  return (
    <table className={styles.table} id={id}>
      <caption>
        Current modelled readings per city (CAMS via Open-Meteo, not ground
        sensors).
      </caption>
      <thead>
        <tr>
          <th scope="col">City</th>
          <th scope="col">US AQI</th>
          <th scope="col">PM2.5 µg/m³</th>
          <th scope="col">CO µg/m³</th>
          <th scope="col">Temp °C</th>
          <th scope="col">Wind</th>
        </tr>
      </thead>
      <tbody>
        {readings.map((r) => (
          <tr key={r.city.id}>
            <th scope="row">{r.city.name}</th>
            <td>
              {r.usAqi === null
                ? 'no data'
                : `${Math.round(r.usAqi)} · ${aqiBand(r.usAqi).label}`}
            </td>
            <td>{r.pm25?.toFixed(1) ?? 'no data'}</td>
            <td>{r.co === null ? 'no data' : Math.round(r.co)}</td>
            <td>{r.temperature?.toFixed(1) ?? 'no data'}</td>
            <td>
              {r.windSpeed === null || r.windDirection === null
                ? 'no data'
                : `${Math.round(r.windSpeed)} km/h from ${compass(r.windDirection)}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
