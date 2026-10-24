import type { ReactNode } from 'react';
import { bandLabel } from '../lib/bands.ts';
import { STATUS_DESCRIPTIONS, STATUS_LABELS } from '../lib/labels.ts';
import type { BandId, ItemStatus } from '../types/domain.ts';
import styles from './ui.module.css';

export type Tone =
  'neutral' | 'ok' | 'warn' | 'error' | 'info' | 'stale' | 'accent';

export function Badge({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const toneClass = tone === 'neutral' ? '' : styles[`tone-${tone}`];
  return (
    <span className={`${styles.badge} ${toneClass}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<ItemStatus, Tone> = {
  verified: 'ok',
  partial: 'info',
  unverified: 'neutral',
  conflicting: 'warn',
  stale: 'stale',
  retracted: 'error',
};

const STATUS_ICON: Record<ItemStatus, string> = {
  verified: '✓',
  partial: '◐',
  unverified: '?',
  conflicting: '⚠',
  stale: '⏱',
  retracted: '✕',
};

export function StatusBadge({ status }: { status: ItemStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} title={STATUS_DESCRIPTIONS[status]}>
      <span aria-hidden="true">{STATUS_ICON[status]}</span>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

const BAND_VAR: Record<BandId, string> = {
  good: 'var(--band-good)',
  moderate: 'var(--band-moderate)',
  sensitive: 'var(--band-sensitive)',
  unhealthy: 'var(--band-unhealthy)',
  very_unhealthy: 'var(--band-very-unhealthy)',
  hazardous: 'var(--band-hazardous)',
};

/** Colour swatch + PM2.5 value + band name. Missing values say "no data", never 0. */
export function BandBadge({
  band,
  pm25,
  compact = false,
  className,
}: {
  band: BandId | null;
  pm25: number | null;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span className={[styles.band, className].filter(Boolean).join(' ')}>
      <span
        className={styles.swatch}
        style={{ background: band ? BAND_VAR[band] : 'var(--band-unknown)' }}
        aria-hidden="true"
      />
      {pm25 === null ? (
        <span>no data</span>
      ) : (
        <span>
          <span className={styles.bandValue}>{Math.round(pm25)}</span>
          {!compact && ' µg/m³'}
          {band && <span> · {bandLabel(band)}</span>}
        </span>
      )}
    </span>
  );
}
