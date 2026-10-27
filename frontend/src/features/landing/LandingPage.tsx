import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BookOpenCheck,
  Database,
  FileSearch,
  Network,
  Scale,
  ShieldCheck,
} from 'lucide-react';
import {
  AQI_BANDS,
  aqiBand,
  compass,
  hazeDensity,
  hotspotsInLast,
  isStale,
  type CityReading,
} from '../../shared/data/airQuality.ts';
import { useRegionData } from '../../shared/data/useRegionData.ts';
import { Badge } from '../../shared/ui/Badge.tsx';
import { buttonClass } from '../../shared/ui/Button.tsx';
import { HazeMark } from '../../shared/ui/HazeMark.tsx';
import { Skeleton } from '../../shared/ui/States.tsx';
import { TimeAgo } from '../../shared/ui/TimeAgo.tsx';
import { RegionView } from './RegionView.tsx';
import styles from './LandingPage.module.css';

const CAPABILITIES = [
  {
    icon: FileSearch,
    title: 'Source-backed explanations',
    body: 'Import text, Markdown, CSV or JSON and get answers that say what the evidence does and does not establish.',
  },
  {
    icon: Network,
    title: 'Episode investigations',
    body: 'A Manager plans a dependency graph of specialist assignments for a place and date range, separating modeled values from observations.',
  },
  {
    icon: Scale,
    title: 'Damage appraisal',
    body: 'Physical, financial incidence and social welfare views built from retained World Model evidence, never invented values.',
  },
  {
    icon: ShieldCheck,
    title: 'Independent review',
    body: 'EvidenceCritic reconstructs every account and component, so numbers are checked rather than trusted.',
  },
];

const STEPS = [
  [
    'Ask',
    'Describe the objective in plain language, with sources if you have them.',
  ],
  [
    'Plan',
    'The Manager answers directly or delegates to specialists with typed tools.',
  ],
  [
    'Trace',
    'Every work product is immutable and linked to the exact evidence behind it.',
  ],
  [
    'Correct',
    'Questions, corrections and controls stay visible while the task runs.',
  ],
] as const;

const EXAMPLE =
  'Investigate PM2.5 evidence for Klang during 2026-10-24 to 2026-10-25, distinguish modeled values from observations, and identify coverage gaps.';

/** Counts up to a number once; static when the user prefers reduced motion. */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 900);
      const eased = 1 - (1 - p) ** 3;
      setShown(Math.round(origin + (value - origin) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown}</>;
}

function Readout({
  reading,
  fetchedAt,
  stale,
}: {
  reading: CityReading | undefined;
  fetchedAt: string | undefined;
  stale: boolean;
}) {
  const band = reading?.usAqi != null ? aqiBand(reading.usAqi) : null;
  return (
    <section
      className={styles.readout}
      aria-labelledby="readout-title"
      aria-live="polite"
    >
      <header className={styles.readoutHead}>
        <h2 id="readout-title">
          Right now in {reading?.city.name ?? 'Kuala Lumpur'}
        </h2>
        <Badge tone={stale ? 'stale' : 'info'} title="CAMS model output via Open-Meteo">
          {stale ? 'Stale · modelled' : 'Modelled'}
        </Badge>
      </header>
      {!reading ? (
        <div className={styles.readoutSkeleton}>
          <Skeleton height="2.5rem" width="60%" />
          <Skeleton />
        </div>
      ) : (
        <>
          <div className={styles.aqiRow}>
            <span className={styles.aqiValue}>
              {reading.usAqi === null ? '—' : Math.round(reading.usAqi)}
            </span>
            <span className={styles.aqiUnit}>US AQI</span>
            {band ? (
              <span
                className={styles.bandChip}
                style={
                  {
                    '--chip-bg': `var(--band-${band.cssVar})`,
                    '--chip-ink': `var(--band-${band.cssVar}-ink)`,
                  } as CSSProperties
                }
              >
                {band.label}
              </span>
            ) : (
              <span className={styles.bandChip}>no data</span>
            )}
          </div>
          <dl className={styles.metrics}>
            <div>
              <dt>PM2.5</dt>
              <dd>
                {reading.pm25 === null ? 'no data' : reading.pm25.toFixed(1)}
                <small> µg/m³</small>
              </dd>
            </div>
            <div>
              <dt>CO</dt>
              <dd>
                {reading.co === null ? 'no data' : Math.round(reading.co)}
                <small> µg/m³</small>
              </dd>
            </div>
            <div>
              <dt>Temp</dt>
              <dd>
                {reading.temperature === null
                  ? 'no data'
                  : reading.temperature.toFixed(1)}
                <small> °C</small>
              </dd>
            </div>
            <div>
              <dt>Wind</dt>
              <dd>
                {reading.windSpeed === null || reading.windDirection === null ? (
                  'no data'
                ) : (
                  <>
                    {Math.round(reading.windSpeed)}
                    <small> km/h {compass(reading.windDirection)}</small>
                  </>
                )}
              </dd>
            </div>
          </dl>
        </>
      )}
      <p className={styles.readoutFoot}>
        {fetchedAt ? (
          <>
            Data updated <TimeAgo iso={fetchedAt} />
            {reading?.observedAt && (
              <>
                {' '}
                · model hour <TimeAgo iso={reading.observedAt} />
              </>
            )}
          </>
        ) : (
          'Fetching live readings…'
        )}
        <br />
        Modelled by CAMS via Open-Meteo, not a ground sensor.
      </p>
    </section>
  );
}

export function LandingPage() {
  const region = useRegionData();
  const [selectedId, setSelectedId] = useState('kl');
  const onSelect = useCallback((id: string) => setSelectedId(id), []);

  const readings = region.snapshot?.readings ?? [];
  const selected = readings.find((r) => r.city.id === selectedId);
  const kl = readings.find((r) => r.city.id === 'kl');
  const stale = region.snapshot ? isStale(region.snapshot) : false;

  const withAqi = readings.filter((r) => r.usAqi !== null);
  const worst = withAqi.reduce<CityReading | null>(
    (w, r) => (!w || (r.usAqi ?? 0) > (w.usAqi ?? 0) ? r : w),
    null,
  );
  const unhealthyCount = withAqi.filter((r) => (r.usAqi ?? 0) > 150).length;
  const fires = region.fires;

  const density = hazeDensity(kl?.pm25 ?? null);

  return (
    <div
      className={styles.page}
      data-theme="night"
      style={{ '--haze-density': density } as CSSProperties}
    >
      <div className={styles.atmosphere} aria-hidden="true">
        <span className={`${styles.fog} ${styles.fogA}`} />
        <span className={`${styles.fog} ${styles.fogB}`} />
      </div>

      <header className={styles.topbar}>
        <Link to="/" className={styles.brand}>
          <HazeMark size={24} />
          Haze
        </Link>
        <nav className={styles.topnav} aria-label="Primary">
          <Link viewTransition to="/world-model">World Model</Link>
          <Link viewTransition to="/damage-account">Damage appraisal</Link>
          <Link viewTransition to="/dashboard" className={buttonClass('primary', 'small')}>
            Open app
          </Link>
        </nav>
      </header>

      <main id="main">
        <section className={styles.hero}>
          <div className={styles.heroText}>
            <p className={styles.eyebrow}>
              Transboundary haze · Malaysia &amp; the region
            </p>
            <h1 className={styles.title}>
              Ask about the haze.
              <br />
              <em className={styles.accent}>Get answers you can audit.</em>
            </h1>
            <p className={styles.lede}>
              Agents plan the investigation, cite every source, and name the
              gaps instead of filling them.
            </p>
            <div className={styles.ctas}>
              <Link viewTransition to="/dashboard" className={buttonClass('primary')}>
                Start a task <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <Link viewTransition to="/world-model" className={buttonClass()}>
                <Database size={18} aria-hidden="true" /> Browse the World Model
              </Link>
            </div>
            <Readout
              reading={selected}
              fetchedAt={region.snapshot?.fetchedAt}
              stale={stale}
            />
            {region.status === 'error' && (
              <p className={styles.dataError} role="alert">
                Live readings are unavailable right now ({region.error}). Nothing
                is shown in their place.
              </p>
            )}
            {region.status === 'cached' && region.error && (
              <p className={styles.dataError}>
                Could not refresh ({region.error}); showing the last good
                readings.
              </p>
            )}
          </div>
          <div className={styles.heroGlobe}>
            <RegionView
              readings={readings}
              fires={fires}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          </div>
        </section>

        <section className={styles.section} aria-labelledby="bands-title">
          <h2 id="bands-title" className="visually-hidden">
            US AQI bands
          </h2>
          <ol className={styles.bands}>
            {AQI_BANDS.map((b) => (
              <li
                key={b.id}
                style={
                  {
                    '--chip-bg': `var(--band-${b.cssVar})`,
                    '--chip-ink': `var(--band-${b.cssVar}-ink)`,
                  } as CSSProperties
                }
              >
                <span className={styles.bandRange}>
                  {b.max === Infinity ? '301+' : `≤ ${b.max}`}
                </span>
                <span>{b.label}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.section} aria-labelledby="region-title">
          <h2 id="region-title">Haze across the region</h2>
          <dl className={styles.stats}>
            <div className={styles.stat}>
              <dt>Worst city now</dt>
              <dd>
                {worst ? (
                  <>
                    <span className={styles.statValue}>
                      <CountUp value={Math.round(worst.usAqi ?? 0)} />
                    </span>
                    <span className={styles.statLabel}>
                      US AQI · {worst.city.name}
                    </span>
                  </>
                ) : (
                  <span className={styles.statLabel}>no data</span>
                )}
              </dd>
            </div>
            <div className={styles.stat}>
              <dt>Fire hotspots, last 24 h</dt>
              <dd>
                {fires?.status === 'ok' ? (
                  <>
                    <span className={styles.statValue}>
                      <CountUp value={hotspotsInLast(fires.hotspots, 24)} />
                    </span>
                    <span className={styles.statLabel}>
                      VIIRS detections, lat −10…12, lng 92…120
                    </span>
                  </>
                ) : (
                  <span className={styles.statLabel}>
                    {fires?.status === 'no-key'
                      ? 'Needs a FIRMS key (not shown, not guessed)'
                      : 'Unavailable'}
                  </span>
                )}
              </dd>
            </div>
            <div className={styles.stat}>
              <dt>Cities Unhealthy or worse</dt>
              <dd>
                {withAqi.length > 0 ? (
                  <>
                    <span className={styles.statValue}>
                      <CountUp value={unhealthyCount} />
                    </span>
                    <span className={styles.statLabel}>
                      of {withAqi.length} tracked (US AQI &gt; 150)
                    </span>
                  </>
                ) : (
                  <span className={styles.statLabel}>no data</span>
                )}
              </dd>
            </div>
          </dl>
          <details className={styles.about}>
            <summary>About this data</summary>
            <p>
              City values are <strong>modelled</strong> by the Copernicus
              Atmosphere Monitoring Service (CAMS) and served by Open-Meteo; they
              are not readings from a ground sensor. Malaysia's Department of
              Environment (DOE) publishes its own Air Pollutant Index (API) from
              ground stations, which uses a different scale, so official values
              may differ from this US AQI view. Satellite layers come from NASA
              GIBS and lag real time; each shows its observation date. Fire
              detections come from NASA FIRMS.
            </p>
          </details>
        </section>

        <section className={styles.section} aria-labelledby="caps">
          <h2 id="caps">What Haze does</h2>
          <div className={styles.grid}>
            {CAPABILITIES.map(({ icon: Icon, title, body }) => (
              <article key={title} className={styles.card}>
                <Icon size={22} aria-hidden="true" className={styles.icon} />
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
          <figure className={styles.prompt}>
            <figcaption>Example objective</figcaption>
            <p>{EXAMPLE}</p>
          </figure>
        </section>

        <section className={styles.section} aria-labelledby="how">
          <h2 id="how">How a task runs</h2>
          <ol className={styles.steps}>
            {STEPS.map(([name, text], i) => (
              <li key={name}>
                <span className={styles.stepNum}>0{i + 1}</span>
                <div>
                  <h3>{name}</h3>
                  <p>{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.closing}>
          <BookOpenCheck size={28} aria-hidden="true" />
          <h2>Missing evidence is an answer too.</h2>
          <p>
            When the data is not there, Haze reports an explicit acquisition gap
            rather than guessing.
          </p>
          <Link viewTransition to="/dashboard" className={buttonClass('primary')}>
            Open the dashboard <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </section>
      </main>

      <footer className={styles.footer}>
        <p>Haze Agent · local-first, durable tasks over one v3 API</p>
        <p>
          Weather and air-quality data by{' '}
          <a href="https://open-meteo.com/">Open-Meteo.com</a> (CC BY 4.0),
          modelled by <a href="https://atmosphere.copernicus.eu/">CAMS</a>{' '}
          (Copernicus). Satellite imagery:{' '}
          <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>. Fire
          detections: <a href="https://firms.modaps.eosdis.nasa.gov/">NASA FIRMS</a>
          . Both part of NASA EOSDIS. Not medical advice.
        </p>
      </footer>
    </div>
  );
}
