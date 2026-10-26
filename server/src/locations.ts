import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Location } from '../../app/contracts/haze-evidence.ts';
import { LOCATION_SEEDS } from '../../frontend/src/mock/generator/locations.ts';
import type { Coverage } from './config.ts';

/**
 * The places HazeOps watches. Coordinates and time zones are real and shared with the
 * frontend's location list (only its air-quality numbers are fictional, and those are
 * not used here). Location is a data field: nothing is hard-coded to one city.
 *
 * The fallback place is used only when a request names no place and has no focus
 * item, and every answer says so. It is not a default for anything else (v0.14 §1).
 */
export const FALLBACK_LOCATION_ID = 'klang';

const SEEDED: Location[] = LOCATION_SEEDS.map((seed) => seed.location);

/** All other Malaysian cities and towns (server/config/locations-malaysia.json). */
const MALAYSIA_FILE = fileURLToPath(
  new URL('../config/locations-malaysia.json', import.meta.url),
);
const MALAYSIA: Location[] = existsSync(MALAYSIA_FILE)
  ? (
      JSON.parse(readFileSync(MALAYSIA_FILE, 'utf8')) as {
        places: { location: Location }[];
      }
    ).places.map((p) => p.location)
  : [];

const seededIds = new Set(SEEDED.map((l) => l.id));
const ALL: readonly Location[] = [
  ...SEEDED,
  ...MALAYSIA.filter((l) => !seededIds.has(l.id)),
];

export function locationsFor(coverage: Coverage): Location[] {
  const selected = ALL.filter((location) => {
    if (coverage === 'malaysia') return location.countryCode === 'MY';
    if (coverage === 'asean') return location.region === 'Southeast Asia';
    return true;
  });
  return [
    ...selected.filter((l) => l.id === FALLBACK_LOCATION_ID),
    ...selected.filter((l) => l.id !== FALLBACK_LOCATION_ID),
  ];
}

export {
  distanceKm,
  nearestLocation,
} from '../../dist/capabilities/evidence-collection/locations.js';
