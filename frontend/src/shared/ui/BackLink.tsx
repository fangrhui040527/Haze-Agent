import type { ReactNode } from 'react';
import { Link } from 'react-router';
import styles from './ui.module.css';

/** Pill-shaped "back to the dashboard" link with an animated arrow. */
export function BackLink({ children }: { children: ReactNode }) {
  return (
    <Link to="/" className={styles.backLink}>
      {children}
    </Link>
  );
}
