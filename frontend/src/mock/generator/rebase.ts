import type { DemoDataset } from '../../shared/types/dataset.ts';
import type { HazeItem } from '../../shared/types/domain.ts';

/**
 * Shift every timestamp in the dataset so the newest item was updated `lagMs` before `nowMs`.
 *
 * Why: the seed file is generated once and committed. Without shifting, opening the app a
 * week later would show everything as a week old (and the ranking would treat it all as stale).
 * Relative times between items are preserved.
 */
export function rebaseDataset(
  dataset: DemoDataset,
  nowMs: number,
  lagMs = 60_000,
): DemoDataset {
  const newest = Math.max(
    ...dataset.items
      .map((i) => Date.parse(i.updatedAt))
      .filter(Number.isFinite),
  );
  if (!Number.isFinite(newest)) return dataset;
  const offset = nowMs - lagMs - newest;
  if (Math.abs(offset) < 60_000) return dataset;

  const shift = (iso: string) =>
    new Date(Date.parse(iso) + offset).toISOString();
  const shiftOrNull = (iso: string | null) =>
    iso === null ? null : shift(iso);

  const items: HazeItem[] = dataset.items.map((item) => ({
    ...item,
    observedAt: shift(item.observedAt),
    updatedAt: shift(item.updatedAt),
    forecast: item.forecast
      ? {
          ...item.forecast,
          validFrom: shift(item.forecast.validFrom),
          validTo: shift(item.forecast.validTo),
        }
      : null,
    sources: item.sources.map((s) => ({
      ...s,
      measuredAt: shiftOrNull(s.measuredAt),
      publishedAt: shiftOrNull(s.publishedAt),
      retrievedAt: shift(s.retrievedAt),
      validUntil: shiftOrNull(s.validUntil),
    })),
    timeline: item.timeline.map((t) => ({ ...t, at: shift(t.at) })),
  }));

  // The generation time can be slightly after the newest item, so never let it land in the future.
  const generatedAt = new Date(
    Math.min(Date.parse(shift(dataset.generatedAt)), nowMs),
  ).toISOString();
  return { ...dataset, generatedAt, items };
}
