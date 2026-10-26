import type { Location } from '../contracts/haze-evidence.js';
import locationRegistry from './config/locations.json' with { type: 'json' };
import type { Coverage } from './config.js';

/** Real geography only. Synthetic air-quality profiles stay in the frontend. */
const locations: readonly Location[] = locationRegistry.locations as Location[];
export const FALLBACK_LOCATION_ID = 'klang';

export function locationsFor(coverage: Coverage): Location[] {
  const selected = locations.filter((location) => {
    if (coverage === 'malaysia') return location.countryCode === 'MY';
    if (coverage === 'asean') return location.region === 'Southeast Asia';
    return true;
  });
  return [
    ...selected.filter((location) => location.id === FALLBACK_LOCATION_ID),
    ...selected.filter((location) => location.id !== FALLBACK_LOCATION_ID),
  ].map((location) => ({ ...location }));
}

export {
  distanceKm,
  nearestLocation,
} from '../capabilities/evidence-collection/locations.js';
