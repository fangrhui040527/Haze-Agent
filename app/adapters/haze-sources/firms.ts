import { boundedFetch, type FetchedBytes } from './http.js';

const BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

export function firmsAreaUrl(
  mapKey: string,
  sensor: string,
  area: string,
): string {
  return `${BASE}/${mapKey}/${sensor}/${area}/2`;
}

export function fetchFirmsArea(
  mapKey: string,
  sensor: string,
  area: string,
  signal: AbortSignal,
): Promise<FetchedBytes> {
  return boundedFetch(firmsAreaUrl(mapKey, sensor, area), {
    signal,
    label: `NASA FIRMS ${sensor}`,
  });
}
