import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import styles from './Demos.module.css';

export function DemoFrame({
  title,
  description,
  recordedAt,
  children,
}: {
  title: string;
  description: string;
  recordedAt?: string;
  children: ReactNode;
}) {
  return (
    <article className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Explore Haze</p>
        <h1>{title}</h1>
        <p>{description}</p>
        <nav className={styles.links} aria-label="Demo examples">
          <NavLink to="/demos" end>
            All demos
          </NavLink>
          <NavLink to="/demos/damage-account">Damage account</NavLink>
          <NavLink to="/demos/damage-reduction">Damage reduction</NavLink>
        </nav>
      </header>
      <aside className={styles.notice} aria-label="About these demos">
        <strong>Recorded synthetic examples</strong>
        <p>
          Browse completed examples with their original sources and reviews.
          Reviews describe the saved run. Viewing a demo starts no live task.
        </p>
        {recordedAt && (
          <p className={styles.meta}>
            Recorded{' '}
            <time dateTime={recordedAt}>
              {new Date(recordedAt).toISOString().slice(0, 10)}
            </time>
            .
          </p>
        )}
        <Link to="/dashboard">Return to the app</Link>
      </aside>
      {children}
    </article>
  );
}
