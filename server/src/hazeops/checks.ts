import type { EvidenceCheck } from '../../../frontend/src/shared/types/domain.ts';

/**
 * HazeOps evidence checks. Per Spec §4.2 there are four layers:
 *   1. identity and integrity      -> HazeOps (here)
 *   2. coverage and alignment      -> HazeOps (here)
 *   3. numbers and operating checks -> independent checker (EvidenceCritic)
 *   4. scientific applicability     -> qualified human review
 * Layers 3–4 are reported as pending, never as passed: HazeOps "cannot grant
 * scientific acceptance" (Guide §2) and does not check its own work.
 */

export function hashCheck(sha256: string, bytes: number): EvidenceCheck {
  return {
    id: 'identity.hash',
    label: 'Raw bytes pinned',
    result: 'pass',
    detail: `SHA-256 ${sha256.slice(0, 12)}… over ${bytes} bytes. Identifies the exact material; says nothing about its truth.`,
  };
}

export function licenceCheck(licence: string): EvidenceCheck {
  return {
    id: 'identity.licence',
    label: 'Licence / access recorded',
    result: licence ? 'pass' : 'fail',
    detail: licence || 'No licence or access terms recorded.',
  };
}

export function provenanceCheck(
  upstream: string,
  retrievedAt: string,
): EvidenceCheck {
  return {
    id: 'identity.provenance',
    label: 'Provenance recorded',
    result: 'pass',
    detail: `Upstream ${upstream}, retrieved ${retrievedAt}.`,
  };
}

/** Units must be µg/m³ after normalisation (Open-Meteo sends the Greek mu). */
export function normaliseUnit(unit: string | undefined | null): 'µg/m³' | null {
  if (!unit) return null;
  const cleaned = unit.replace('μ', 'µ').replace(/\s/g, '');
  return cleaned === 'µg/m³' || cleaned === 'µg/m3' ? 'µg/m³' : null;
}

export function unitCheck(
  upstreamUnit: string | null | undefined,
): EvidenceCheck {
  const unit = normaliseUnit(upstreamUnit);
  return {
    id: 'coverage.units',
    label: 'Units',
    result: unit ? 'pass' : 'fail',
    detail: unit
      ? `PM2.5 in µg/m³ (source unit "${upstreamUnit}").`
      : `Unexpected unit "${upstreamUnit ?? 'missing'}"; values not usable.`,
  };
}

export function valuesCheck(
  values: (number | null | undefined)[],
): EvidenceCheck {
  const invalid = values.filter(
    (v) => typeof v === 'number' && (!Number.isFinite(v) || v < 0),
  ).length;
  const missing = values.filter((v) => v === null || v === undefined).length;
  if (invalid > 0) {
    return {
      id: 'coverage.values',
      label: 'Values valid',
      result: 'fail',
      detail: `${invalid} negative or non-finite value(s) rejected.`,
    };
  }
  return {
    id: 'coverage.values',
    label: 'Values valid',
    result: missing > 0 ? 'warn' : 'pass',
    detail:
      missing > 0
        ? `${values.length - missing} of ${values.length} values present; ${missing} missing (kept as missing, never zero).`
        : `${values.length} value(s), all finite and non-negative.`,
  };
}

export function resolutionCheck(
  resolution: string,
  coarse: boolean,
): EvidenceCheck {
  return {
    id: 'coverage.resolution',
    label: 'Native resolution stated',
    result: coarse ? 'warn' : 'pass',
    detail: coarse
      ? `${resolution}. A regional model cell, not a point measurement; finer timing or location is not implied.`
      : resolution,
  };
}

export function decisionTimeCheck(
  issuedAt: string | null,
  retrievedAt: string,
): EvidenceCheck {
  if (!issuedAt) {
    return {
      id: 'coverage.issue_time',
      label: 'Issued before use',
      result: 'warn',
      detail:
        'The source does not state an issue time, so availability before a decision cannot be confirmed.',
    };
  }
  const ok = issuedAt <= retrievedAt;
  return {
    id: 'coverage.issue_time',
    label: 'Issued before use',
    result: ok ? 'pass' : 'fail',
    detail: ok
      ? `Issued ${issuedAt}, before retrieval.`
      : `Issue time ${issuedAt} is after retrieval ${retrievedAt}.`,
  };
}

export function pendingReviewChecks(): EvidenceCheck[] {
  return [
    {
      id: 'review.independent',
      label: 'Independent check (EvidenceCritic)',
      result: 'pending',
      detail:
        'Not connected yet. HazeOps does not check its own work, so these values are not independently verified.',
    },
    {
      id: 'review.applicability',
      label: 'Intended-use review',
      result: 'pending',
      detail:
        'No qualified reviewer has assessed this source for a named use. Shown for information only.',
    },
  ];
}

/** Computed when an item is read, because staleness depends on the current time. */
export function freshnessCheck(
  observedAt: string,
  now: Date,
  maxAgeMinutes: number,
): EvidenceCheck {
  const ageMinutes = Math.round(
    (now.getTime() - Date.parse(observedAt)) / 60000,
  );
  const stale = ageMinutes > maxAgeMinutes;
  return {
    id: 'coverage.freshness',
    label: 'Fresh',
    result: stale ? 'fail' : 'pass',
    detail: stale
      ? `Newest value is ${formatAge(ageMinutes)} old; the freshness rule for this source is ${formatAge(maxAgeMinutes)}.`
      : `Newest value is ${formatAge(ageMinutes)} old (rule: ${formatAge(maxAgeMinutes)}).`,
  };
}

function formatAge(minutes: number): string {
  if (minutes < 0) return 'in the future';
  if (minutes < 90) return `${minutes} min`;
  const hours = minutes / 60;
  return hours < 48
    ? `${hours.toFixed(1)} h`
    : `${(hours / 24).toFixed(1)} days`;
}
