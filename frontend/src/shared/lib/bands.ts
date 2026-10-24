import type { BandId, HazeItem } from '../types/domain.ts';

/**
 * Air-quality bands used in the DEMO.
 *
 * Thresholds follow the US EPA PM2.5 (24-hour) breakpoints, 2024 revision, in µg/m³.
 * Real deployments must apply each location's own official standard (Location.aqiStandard);
 * that is a TODO for when real data arrives. The UI always labels these as "demo bands".
 */
export const BAND_STANDARD_LABEL =
  'Demo bands: US EPA PM2.5 breakpoints (2024)';

export const BANDS: readonly { id: BandId; label: string; maxPm25: number }[] =
  [
    { id: 'good', label: 'Good', maxPm25: 9.0 },
    { id: 'moderate', label: 'Moderate', maxPm25: 35.4 },
    { id: 'sensitive', label: 'Unhealthy for sensitive groups', maxPm25: 55.4 },
    { id: 'unhealthy', label: 'Unhealthy', maxPm25: 125.4 },
    { id: 'very_unhealthy', label: 'Very unhealthy', maxPm25: 225.4 },
    { id: 'hazardous', label: 'Hazardous', maxPm25: Number.POSITIVE_INFINITY },
  ];

export function bandForPm25(value: number): BandId {
  for (const band of BANDS) {
    if (value <= band.maxPm25) return band.id;
  }
  return 'hazardous';
}

export function bandIndex(band: BandId): number {
  return BANDS.findIndex((b) => b.id === band);
}

export function bandLabel(band: BandId): string {
  return BANDS.find((b) => b.id === band)?.label ?? band;
}

/** The PM2.5 value an item is "about": its measurement, else its forecast. null = no data. */
export function itemPm25(item: HazeItem): number | null {
  const measured = item.measurements.find((m) => m.pollutant === 'pm25')?.value;
  if (measured !== undefined && measured !== null) return measured;
  return item.forecast?.expectedPm25 ?? null;
}

export function itemBand(item: HazeItem): BandId | null {
  const pm25 = itemPm25(item);
  return pm25 === null ? null : bandForPm25(pm25);
}
