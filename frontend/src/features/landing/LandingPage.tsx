import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BookOpenCheck,
  ChevronDown,
  FileSearch,
  Network,
  Scale,
  ShieldCheck,
  Table2,
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
import { ReadingsTable, RegionView } from './RegionView.tsx';
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

/**
 * A faint amber glow that trails the mouse behind the page content. Eased so it
 * lags a little, idle (no rAF) once settled, and off for touch or reduced motion.
 */
function CursorGlow() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (
      !el ||
      !window.matchMedia('(hover: hover) and (pointer: fine)').matches ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    const target = { x: 0, y: 0 };
    const pos = { x: 0, y: 0 };
    let raf = 0;
    let placed = false;
    const tick = () => {
      pos.x += (target.x - pos.x) * 0.12;
      pos.y += (target.y - pos.y) * 0.12;
      el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
      raf =
        Math.abs(target.x - pos.x) + Math.abs(target.y - pos.y) > 0.5
          ? requestAnimationFrame(tick)
          : 0;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      target.x = e.clientX;
      target.y = e.clientY;
      if (!placed) {
        // Appear where the cursor is instead of sweeping in from the corner.
        pos.x = target.x;
        pos.y = target.y;
        placed = true;
      }
      el.dataset.active = 'true';
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const onLeave = () => delete el.dataset.active;
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, []);
  return <span ref={ref} className={styles.glow} aria-hidden="true" />;
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
        <Badge
          tone={stale ? 'stale' : 'info'}
          title="CAMS model output via Open-Meteo"
        >
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
                {reading.windSpeed === null ||
                reading.windDirection === null ? (
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
  const tableId = useId();

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
      <CursorGlow />

      <main id="main">
        <section className={styles.hero}>
          <div className={styles.heroText}>
            <div className={styles.masthead}>
              <span className={styles.brand}>
                <HazeMark size={28} />
                Haze
              </span>
              <p className={styles.eyebrow}>
                Transboundary haze · Malaysia &amp; the region
              </p>
            </div>
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
              <Link
                viewTransition
                to="/dashboard"
                className={buttonClass('primary')}
              >
                Start a task <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </div>
            <Readout
              reading={selected}
              fetchedAt={region.snapshot?.fetchedAt}
              stale={stale}
            />
            {readings.length > 0 && (
              <details className={styles.cityTable}>
                <summary>
                  <Table2 size={16} aria-hidden="true" />
                  <span className={styles.cityTableLabel}>
                    Compare all {readings.length} cities
                  </span>
                  <span className={styles.cityTableHint} aria-hidden="true" />
                  <ChevronDown
                    size={16}
                    aria-hidden="true"
                    className={styles.cityTableChevron}
                  />
                </summary>
                <ReadingsTable
                  id={tableId}
                  readings={readings}
                  selectedId={selectedId}
                />
              </details>
            )}
            {region.status === 'error' && (
              <p className={styles.dataError} role="alert">
                Live readings are unavailable right now ({region.error}).
                Nothing is shown in their place.
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
              tableId={tableId}
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
              Atmosphere Monitoring Service (CAMS) and served by Open-Meteo;
              they are not readings from a ground sensor. Malaysia's Department
              of Environment (DOE) publishes its own Air Pollutant Index (API)
              from ground stations, which uses a different scale, so official
              values may differ from this US AQI view. Satellite layers come
              from NASA GIBS and lag real time; each shows its observation date.
              Fire detections come from NASA FIRMS.
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
          detections:{' '}
          <a href="https://firms.modaps.eosdis.nasa.gov/">NASA FIRMS</a>. Both
          part of NASA EOSDIS. Not medical advice.
        </p>
      </footer>
    </div>
  );
}
