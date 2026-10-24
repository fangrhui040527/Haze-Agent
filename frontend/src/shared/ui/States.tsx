import type { HTMLAttributes, ReactNode } from 'react';
import styles from './ui.module.css';

/** Empty / error / info message with an optional action button. */
export function StateMessage({
  kind,
  title,
  children,
  action,
}: {
  kind: 'empty' | 'error' | 'info';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={`${styles.state} ${kind === 'error' ? styles.stateError : ''}`}
      role={kind === 'error' ? 'alert' : undefined}
    >
      <p className={styles.stateTitle}>{title}</p>
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

export function Skeleton({
  width = '100%',
  height = '1em',
}: {
  width?: string;
  height?: string;
}) {
  return (
    <span
      className={styles.skeleton}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <>
      <span className={styles.spinner} aria-hidden="true" />
      {label && <span className="visually-hidden">{label}</span>}
    </>
  );
}

export function Panel({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & HTMLAttributes<HTMLElement>) {
  return (
    <section className={`${styles.panel} ${className ?? ''}`} {...rest}>
      {children}
    </section>
  );
}
