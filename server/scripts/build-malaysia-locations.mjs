// Builds server/config/locations-malaysia.json: every Malaysian city with official city
// status, every state capital and federal territory, and the larger towns, so HazeOps
// covers all of Malaysia rather than 15 places.
//
// Two sources, both GeoNames data (CC BY 4.0):
//   1. A hand-made list of names and states (below), geocoded with the Open-Meteo
//      Geocoding API. A result is accepted only when it is in Malaysia, in the expected
//      state, and a populated place.
//   2. With GEONAMES_USERNAME set, every Malaysian populated place of 15,000 people or
//      more from the GeoNames search API (needs the account's free web services enabled).
// Places within 3 km of one already chosen (or of the frontend's list: Klang, Kuala
// Lumpur, ...) are skipped, keeping the larger place.
//
// Run: node --env-file-if-exists=.env server/scripts/build-malaysia-locations.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOCATION_SEEDS } from '../../frontend/src/mock/generator/locations.ts';

const OUT = fileURLToPath(
  new URL('../config/locations-malaysia.json', import.meta.url),
);
const GEOCODER = 'https://geocoding-api.open-meteo.com/v1/search';

/** [name to search, expected GeoNames state (admin1), display name if different] */
const PLACES = [
  ['Putrajaya', 'Putrajaya'],
  ['Labuan', 'Labuan', 'Labuan'],
  ['Petaling Jaya', 'Selangor'],
  ['Subang Jaya', 'Selangor'],
  ['Kajang', 'Selangor'],
  ['Ampang', 'Selangor'],
  ['Rawang', 'Selangor'],
  ['Puchong', 'Selangor'],
  ['Cyberjaya', 'Selangor'],
  ['Banting', 'Selangor'],
  ['Kuala Selangor', 'Selangor'],
  ['Kuala Kubu Bharu', 'Selangor'],
  ['Butterworth', 'Penang'],
  ['Bukit Mertajam', 'Penang'],
  ['Taiping', 'Perak'],
  ['Teluk Intan', 'Perak'],
  ['Lumut', 'Perak'],
  ['Sitiawan', 'Perak'],
  ['Kuala Kangsar', 'Perak'],
  ['Kampar', 'Perak'],
  ['Sungai Petani', 'Kedah'],
  ['Kulim', 'Kedah'],
  ['Kuah', 'Kedah', 'Langkawi (Kuah)'],
  ['Kangar', 'Perlis'],
  ['Kuala Krai', 'Kelantan'],
  ['Gua Musang', 'Kelantan'],
  ['Pasir Mas', 'Kelantan'],
  ['Kuala Terengganu', 'Terengganu'],
  ['Cukai', 'Terengganu', 'Kemaman (Cukai)'],
  ['Dungun', 'Terengganu'],
  ['Temerloh', 'Pahang'],
  ['Bentong', 'Pahang'],
  ['Raub', 'Pahang'],
  ['Jerantut', 'Pahang'],
  ['Tanah Rata', 'Pahang', 'Cameron Highlands (Tanah Rata)'],
  ['Pekan', 'Pahang'],
  ['Port Dickson', 'Negeri Sembilan'],
  // Nilai is not in GeoNames under any name tried; Seremban (~15 km) covers it.
  ['Alor Gajah', 'Melaka'],
  ['Iskandar Puteri', 'Johor'],
  ['Pasir Gudang', 'Johor'],
  ['Batu Pahat', 'Johor'],
  ['Muar', 'Johor'],
  ['Kluang', 'Johor'],
  ['Segamat', 'Johor'],
  ['Kota Tinggi', 'Johor'],
  ['Pontian Kechil', 'Johor', 'Pontian'],
  ['Mersing', 'Johor'],
  ['Bintulu', 'Sarawak'],
  ['Sri Aman', 'Sarawak'],
  ['Sarikei', 'Sarawak'],
  ['Kapit', 'Sarawak'],
  ['Limbang', 'Sarawak'],
  ['Mukah', 'Sarawak'],
  ['Sandakan', 'Sabah'],
  ['Tawau', 'Sabah'],
  ['Lahad Datu', 'Sabah'],
  ['Keningau', 'Sabah'],
  ['Semporna', 'Sabah'],
  ['Kudat', 'Sabah'],
  ['Beaufort', 'Sabah'],
];

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const populationBand = (p) =>
  !p
    ? 'small'
    : p < 100_000
      ? 'small'
      : p < 500_000
        ? 'medium'
        : p < 2_000_000
          ? 'large'
          : 'mega';

const MERGE_KM = 3;
const rad = Math.PI / 180;
const km = (a, b) =>
  2 *
  6371 *
  Math.asin(
    Math.sqrt(
      Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
        Math.cos(a.lat * rad) *
          Math.cos(b.lat * rad) *
          Math.sin(((b.lon - a.lon) * rad) / 2) ** 2,
    ),
  );

const toPlace = ({
  id,
  name,
  lat,
  lon,
  timeZone,
  population,
  state,
  geonamesId,
  origin,
}) => ({
  location: {
    id,
    name,
    region: 'Southeast Asia',
    country: 'Malaysia',
    countryCode: 'MY',
    lat,
    lon,
    timeZone,
    aqiStandard: 'Malaysia Air Pollutant Index (API)',
    populationBand: populationBand(population),
  },
  state,
  geonamesId,
  population: population ?? null,
  origin,
});

/** Source 1: the hand-made list, geocoded with Open-Meteo. */
async function fromCuratedList(rejected) {
  const places = [];
  for (const [query, state, display] of PLACES) {
    const url = `${GEOCODER}?name=${encodeURIComponent(query)}&count=10&language=en&format=json&countryCode=MY`;
    const body = await (await fetch(url)).json();
    const match = (body.results ?? [])
      .filter(
        (r) =>
          r.country_code === 'MY' &&
          r.admin1 === state &&
          /^PPL/.test(r.feature_code),
      )
      .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
    if (!match) {
      rejected.push(`${query} (${state}): no populated place in that state`);
      continue;
    }
    places.push(
      toPlace({
        id: slug(display ?? query),
        name: display ?? match.name,
        lat: match.latitude,
        lon: match.longitude,
        timeZone: match.timezone,
        population: match.population,
        state,
        geonamesId: match.id,
        origin: 'curated',
      }),
    );
    await new Promise((r) => setTimeout(r, 150)); // be gentle with the free API
  }
  return places;
}

/** Source 2: every Malaysian populated place of 15,000+ people from GeoNames. */
async function fromGeoNames(username) {
  const url = `https://secure.geonames.org/searchJSON?country=MY&featureClass=P&cities=cities15000&maxRows=1000&style=FULL&username=${encodeURIComponent(username)}`;
  const body = await (await fetch(url)).json();
  if (body.status) throw new Error(`GeoNames: ${body.status.message}`);
  return body.geonames
    .filter((g) => g.countryCode === 'MY' && /^PPL/.test(g.fcode))
    .map((g) =>
      toPlace({
        id: slug(g.name),
        name: g.name,
        lat: Number(g.lat),
        lon: Number(g.lng),
        timeZone: g.timezone?.timeZoneId ?? 'Asia/Kuala_Lumpur',
        population: g.population,
        state: g.adminName1,
        geonamesId: g.geonameId,
        origin: 'geonames-cities15000',
      }),
    );
}

const rejected = [];
const username = process.env.GEONAMES_USERNAME?.trim();
const candidates = [
  ...(await fromCuratedList(rejected)),
  ...(username ? await fromGeoNames(username) : []),
].sort((a, b) => (b.population ?? 0) - (a.population ?? 0));

// Keep the larger of any places within MERGE_KM of each other or of the frontend list.
const seeded = LOCATION_SEEDS.map((s) => s.location);
const chosen = [];
for (const place of candidates) {
  const p = place.location;
  const near = [...seeded, ...chosen.map((c) => c.location)].find(
    (q) => q.id === p.id || km(p, q) < MERGE_KM,
  );
  if (near) continue;
  chosen.push(place);
}
chosen.sort(
  (a, b) =>
    a.state.localeCompare(b.state) ||
    a.location.name.localeCompare(b.location.name),
);

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      description:
        'Malaysian places watched by HazeOps in addition to the frontend location list. GeoNames data (CC BY 4.0), via the Open-Meteo Geocoding API and, when a GeoNames username is set, the GeoNames search API (populated places of 15,000+ people).',
      generatedAt: new Date().toISOString(),
      generator: 'server/scripts/build-malaysia-locations.mjs',
      sources: username
        ? ['curated list', 'geonames cities15000']
        : ['curated list'],
      places: chosen,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `wrote ${chosen.length} places (${chosen.filter((c) => c.origin === 'curated').length} curated, ${chosen.filter((c) => c.origin !== 'curated').length} from GeoNames); ${rejected.length} rejected`,
);
for (const line of rejected) console.log(`  rejected: ${line}`);
