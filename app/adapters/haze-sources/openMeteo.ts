import { boundedFetch, type FetchedBytes } from './http.js';

const ENDPOINT = 'https://air-quality-api.open-meteo.com/v1/air-quality';

export function openMeteoUrl(params: URLSearchParams): string {
  return `${ENDPOINT}?${params.toString()}`;
}

/** Retrieve exact provider bytes; interpretation belongs to the collection capability. */
export function fetchOpenMeteo(
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<FetchedBytes> {
  return boundedFetch(openMeteoUrl(params), {
    signal,
    label: 'Open-Meteo air quality',
  });
}
