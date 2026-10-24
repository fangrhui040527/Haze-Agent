import { bandIndex, bandLabel, itemBand } from '../../shared/lib/bands.ts';
import type { HazeItem, Location } from '../../shared/types/domain.ts';

/**
 * THE ranking rule for the live table (docs/03-ui-design.md §6).
 *
 * score = recency (0–40) + severity (0–40) + evidence (0–20) + penalties (0 to −20),
 * clamped to 0–100 and rounded. Retracted items always score 0.
 *
 * - Recency:  40 × 0.5^(hours since `updatedAt` / 6)  → halves every 6 hours.
 * - Severity: demo air-quality band × 8 (Good 0 … Hazardous 40). Items without any PM2.5
 *             value (e.g. a news report with no reading) get a neutral 10.
 * - Evidence: 20 × (passed + 0.5 × warnings) / total checks. No checks → 0.
 * - Penalties: stale −10, conflicting −5, unverified −5.
 *
 * Ties: newer `updatedAt` first, then location name A→Z.
 *
 * Every part is returned with a reason so the UI can show "why this rank".
 * Change the constants below (not the UI) if the team wants a different balance.
 */

export const RANKING = {
  recencyMax: 40,
  recencyHalfLifeHours: 6,
  severityPerBand: 8,
  severityUnknown: 10,
  evidenceMax: 20,
  penaltyStale: -10,
  penaltyConflicting: -5,
  penaltyUnverified: -5,
} as const;

export interface RankPart {
  key: 'recency' | 'severity' | 'evidence' | 'penalty';
  label: string;
  points: number;
  max: number;
  reason: string;
}

export interface RankResult {
  score: number;
  parts: RankPart[];
}

export interface RankedItem {
  item: HazeItem;
  location: Location | null;
  rank: number;
  score: number;
  parts: RankPart[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function rankItem(item: HazeItem, nowMs: number): RankResult {
  if (item.status === 'retracted') {
    return {
      score: 0,
      parts: [
        {
          key: 'penalty',
          label: 'Retracted',
          points: 0,
          max: 0,
          reason: 'Retracted items always score 0.',
        },
      ],
    };
  }

  const ageHours = Math.max(
    0,
    (nowMs - Date.parse(item.updatedAt)) / 3_600_000,
  );
  const recency =
    RANKING.recencyMax * 0.5 ** (ageHours / RANKING.recencyHalfLifeHours);

  const band = itemBand(item);
  const severity =
    band === null
      ? RANKING.severityUnknown
      : bandIndex(band) * RANKING.severityPerBand;

  const total = item.checks.length;
  const passed = item.checks.filter((c) => c.result === 'pass').length;
  const warned = item.checks.filter((c) => c.result === 'warn').length;
  const evidence =
    total === 0 ? 0 : (RANKING.evidenceMax * (passed + 0.5 * warned)) / total;

  let penalty = 0;
  const penaltyReasons: string[] = [];
  if (item.status === 'stale') {
    penalty += RANKING.penaltyStale;
    penaltyReasons.push(`stale ${RANKING.penaltyStale}`);
  }
  if (item.status === 'conflicting') {
    penalty += RANKING.penaltyConflicting;
    penaltyReasons.push(`conflicting sources ${RANKING.penaltyConflicting}`);
  }
  if (item.status === 'unverified') {
    penalty += RANKING.penaltyUnverified;
    penaltyReasons.push(`unverified ${RANKING.penaltyUnverified}`);
  }

  const parts: RankPart[] = [
    {
      key: 'recency',
      label: 'Recency',
      points: round1(recency),
      max: RANKING.recencyMax,
      reason: `Updated ${ageHours < 1 ? `${Math.round(ageHours * 60)} min` : `${round1(ageHours)} h`} ago (halves every ${RANKING.recencyHalfLifeHours} h)`,
    },
    {
      key: 'severity',
      label: 'Air quality',
      points: severity,
      max: RANKING.severityPerBand * 5,
      reason:
        band === null
          ? 'No PM2.5 value, so neutral points'
          : `Band: ${bandLabel(band)}`,
    },
    {
      key: 'evidence',
      label: 'Evidence',
      points: round1(evidence),
      max: RANKING.evidenceMax,
      reason:
        total === 0
          ? 'No evidence checks yet'
          : `${passed} of ${total} checks passed${warned ? `, ${warned} warning(s) count half` : ''}`,
    },
  ];
  if (penalty !== 0) {
    parts.push({
      key: 'penalty',
      label: 'Penalties',
      points: penalty,
      max: 0,
      reason: penaltyReasons.join(', '),
    });
  }

  const score = Math.round(
    Math.min(100, Math.max(0, recency + severity + evidence + penalty)),
  );
  return { score, parts };
}

/** Rank a list of items. Returns new objects; the input is not modified. */
export function rankItems(
  items: readonly HazeItem[],
  locations: readonly Location[],
  nowMs: number,
): RankedItem[] {
  const locationById = new Map(locations.map((l) => [l.id, l]));
  return items
    .map((item) => {
      const { score, parts } = rankItem(item, nowMs);
      return {
        item,
        location: locationById.get(item.locationId) ?? null,
        rank: 0,
        score,
        parts,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        Date.parse(b.item.updatedAt) - Date.parse(a.item.updatedAt) ||
        (a.location?.name ?? '').localeCompare(b.location?.name ?? ''),
    )
    .map((ranked, index) => ({ ...ranked, rank: index + 1 }));
}
