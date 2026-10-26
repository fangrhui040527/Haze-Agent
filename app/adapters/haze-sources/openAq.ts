import { boundedFetch, type FetchedBytes } from './http.js';

const BASE = 'https://api.openaq.org';

export function openAqCatalogueUrl(
  countryId: number,
  parameterId: number,
): string {
  return `${BASE}/v3/locations?countries_id=${countryId}&parameters_id=${parameterId}&limit=1000`;
}

export function fetchOpenAqCatalogue(
  countryId: number,
  parameterId: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<FetchedBytes> {
  return boundedFetch(openAqCatalogueUrl(countryId, parameterId), {
    headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
    signal,
    label: 'OpenAQ station catalogue',
  });
}

export function fetchOpenAqLatest(
  stationId: string,
  stationName: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<FetchedBytes> {
  return boundedFetch(`${BASE}/v3/locations/${stationId}/latest`, {
    headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
    signal,
    label: `OpenAQ latest for ${stationName}`,
  });
}
