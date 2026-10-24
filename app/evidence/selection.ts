import type { EnvironmentalSeries } from '../contracts/index.js';

/**
 * Pinned source-selection rule (Architecture v0.13 §4.3).
 *
 * This slice accepts exactly one declared series per location. When a location
 * resolves to more than one series the conflict is returned unresolved with
 * every alternative and its reason: nothing is chosen implicitly and nothing is
 * silently overwritten.
 */
export const SOURCE_SELECTION_RULE = 'single_declared_series_per_location_v1';

export interface SeriesSelection {
  rule: typeof SOURCE_SELECTION_RULE;
  byLocation: Map<string, EnvironmentalSeries>;
  conflicts: {
    location_id: string;
    candidate_series_ids: string[];
  }[];
  excluded: {
    location_id: string;
    series_id: string;
    reason: 'conflicting_alternative_not_resolved_by_pinned_rule';
  }[];
}

export function selectSeriesByLocation(
  series: readonly EnvironmentalSeries[],
): SeriesSelection {
  const grouped = new Map<string, EnvironmentalSeries[]>();
  for (const entry of series) {
    const existing = grouped.get(entry.location_id);
    if (existing) existing.push(entry);
    else grouped.set(entry.location_id, [entry]);
  }
  const selection: SeriesSelection = {
    rule: SOURCE_SELECTION_RULE,
    byLocation: new Map(),
    conflicts: [],
    excluded: [],
  };
  for (const [locationId, candidates] of grouped) {
    const only = candidates[0];
    if (candidates.length === 1 && only) {
      selection.byLocation.set(locationId, only);
      continue;
    }
    selection.conflicts.push({
      location_id: locationId,
      candidate_series_ids: candidates.map((entry) => entry.series_id),
    });
    for (const candidate of candidates) {
      selection.excluded.push({
        location_id: locationId,
        series_id: candidate.series_id,
        reason: 'conflicting_alternative_not_resolved_by_pinned_rule',
      });
    }
  }
  return selection;
}
