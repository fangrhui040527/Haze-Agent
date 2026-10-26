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
import { buttonClass } from '../../shared/ui/Button.tsx';
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

export function LandingPage() {
  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <span className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            ▦
          </span>
          Haze
        </span>
        <nav className={styles.topnav} aria-label="Primary">
          <Link to="/world-model">World Model</Link>
          <Link to="/damage-account">Damage appraisal</Link>
          <Link to="/dashboard" className={buttonClass('primary')}>
            Open app
          </Link>
        </nav>
      </header>

      <main>
        <section className={styles.hero}>
          <p className={styles.eyebrow}>Evidence-first haze intelligence</p>
          <h1 className={styles.title}>
            Ask about the haze.
            <br />
            <span className={styles.accent}>Get answers you can audit.</span>
          </h1>
          <p className={styles.lede}>
            Haze turns natural-language questions about air quality into
            planned, source-backed investigations. Every figure points back to
            its evidence, and every gap is named instead of filled.
          </p>
          <div className={styles.ctas}>
            <Link to="/dashboard" className={buttonClass('primary')}>
              Start a task <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <Link to="/world-model" className={buttonClass()}>
              <Database size={18} aria-hidden="true" /> Browse the World Model
            </Link>
          </div>

          <figure className={styles.prompt}>
            <figcaption>Example objective</figcaption>
            <p>{EXAMPLE}</p>
          </figure>

          <ol className={styles.bands} aria-label="Air-quality bands">
            {[
              ['good', 'Good'],
              ['moderate', 'Moderate'],
              ['sensitive', 'Sensitive'],
              ['unhealthy', 'Unhealthy'],
              ['very-unhealthy', 'Very unhealthy'],
              ['hazardous', 'Hazardous'],
            ].map(([key, label]) => (
              <li key={key} style={{ background: `var(--band-${key})` }}>
                <span>{label}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.section} aria-labelledby="caps">
          <h2 id="caps">What Haze does</h2>
          <div className={styles.grid}>
            {CAPABILITIES.map(({ icon: Icon, title, body }) => (
              <article key={title} className={styles.card}>
                <Icon size={24} aria-hidden="true" className={styles.icon} />
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section} aria-labelledby="how">
          <h2 id="how">How a task runs</h2>
          <ol className={styles.steps}>
            {STEPS.map(([name, text], i) => (
              <li key={name}>
                <span className={styles.stepNum}>{i + 1}</span>
                <div>
                  <h3>{name}</h3>
                  <p>{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.closing}>
          <BookOpenCheck size={32} aria-hidden="true" />
          <h2>Missing evidence is an answer too.</h2>
          <p>
            When the data is not there, Haze reports an explicit acquisition gap
            rather than guessing.
          </p>
          <Link to="/dashboard" className={buttonClass('primary')}>
            Open the dashboard <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </section>
      </main>

      <footer className={styles.footer}>
        Haze Agent · local-first, durable tasks over one v3 API
      </footer>
    </div>
  );
}
