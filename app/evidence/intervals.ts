/**
 * Half-open `[start, end)` interval arithmetic in whole milliseconds.
 *
 * Architecture v0.13 §4.3 allocates a piecewise-constant hourly concentration
 * across shorter scheduling steps. Allocation is arithmetic over the declared
 * source interval; it never creates sub-hour environmental information, so
 * these helpers only intersect and subtract declared boundaries.
 */
export interface HalfOpenInterval {
  start: number;
  end: number;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/** Whole-millisecond epoch value, or null when the instant is unusable. */
export function parseInstant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Overlap duration; zero when two intervals only meet at a boundary. */
export function overlapMs(a: HalfOpenInterval, b: HalfOpenInterval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Boundaries are whole minutes, so an overlap divides exactly into minutes. */
export function overlapMinutes(a: HalfOpenInterval, b: HalfOpenInterval) {
  return overlapMs(a, b) / MINUTE_MS;
}

/** Sorted, non-overlapping cover of the supplied intervals. */
export function mergeIntervals(
  intervals: readonly HalfOpenInterval[],
): HalfOpenInterval[] {
  const sorted = [...intervals]
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: HalfOpenInterval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else merged.push({ ...interval });
  }
  return merged;
}

/**
 * Parts of `target` no source interval covers, in chronological order. An
 * empty result means complete coverage; a gap is reported as a gap and is
 * never filled by zero, interpolation or a neighbouring value.
 */
export function uncoveredSegments(
  target: HalfOpenInterval,
  sources: readonly HalfOpenInterval[],
): HalfOpenInterval[] {
  if (target.end <= target.start) return [];
  const gaps: HalfOpenInterval[] = [];
  let cursor = target.start;
  for (const source of mergeIntervals(sources)) {
    if (source.end <= cursor) continue;
    if (source.start >= target.end) break;
    if (source.start > cursor) {
      gaps.push({ start: cursor, end: Math.min(source.start, target.end) });
    }
    cursor = Math.max(cursor, source.end);
    if (cursor >= target.end) break;
  }
  if (cursor < target.end) gaps.push({ start: cursor, end: target.end });
  return gaps;
}

/** UTC rendering used by diagnostics and trace records. */
export function toUtcInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}
