/**
 * Live regional air-quality, weather, satellite and fire data for the landing page.
 *
 * Sources (all verified against their official docs / capabilities, 2026-10):
 * - Open-Meteo Air Quality API (CAMS model output, not ground sensors). Batches many
 *   coordinates in one request via comma-separated latitude/longitude.
 * - Open-Meteo Forecast API for 2 m temperature and 10 m wind.
 * - NASA GIBS WMS (EPSG:4326) for satellite overlays, rendered as one image over the region.
 * - NASA FIRMS area API for active-fire detections; needs VITE_FIRMS_MAP_KEY.
 *
 * To swap a provider, replace the fetch function for it and keep the returned types.
 */

export interface City {
  id: string;
  name: string;
  country: 'MY' | 'SG' | 'ID';
  lat: number;
  lng: number;
}

export const CITIES: readonly City[] = [
  { id: 'kl', name: 'Kuala Lumpur', country: 'MY', lat: 3.139, lng: 101.687 },
  { id: 'klang', name: 'Klang', country: 'MY', lat: 3.044, lng: 101.445 },
  { id: 'shah-alam', name: 'Shah Alam', country: 'MY', lat: 3.073, lng: 101.518 },
  { id: 'pj', name: 'Petaling Jaya', country: 'MY', lat: 3.107, lng: 101.607 },
  { id: 'jb', name: 'Johor Bahru', country: 'MY', lat: 1.493, lng: 103.741 },
  { id: 'penang', name: 'Penang', country: 'MY', lat: 5.414, lng: 100.329 },
  { id: 'ipoh', name: 'Ipoh', country: 'MY', lat: 4.597, lng: 101.09 },
  { id: 'kuching', name: 'Kuching', country: 'MY', lat: 1.553, lng: 110.359 },
  { id: 'kk', name: 'Kota Kinabalu', country: 'MY', lat: 5.98, lng: 116.073 },
  { id: 'sg', name: 'Singapore', country: 'SG', lat: 1.352, lng: 103.82 },
  { id: 'medan', name: 'Medan', country: 'ID', lat: 3.595, lng: 98.672 },
  { id: 'pekanbaru', name: 'Pekanbaru', country: 'ID', lat: 0.507, lng: 101.448 },
  { id: 'jambi', name: 'Jambi', country: 'ID', lat: -1.61, lng: 103.613 },
  { id: 'palembang', name: 'Palembang', country: 'ID', lat: -2.976, lng: 104.775 },
  { id: 'pontianak', name: 'Pontianak', country: 'ID', lat: -0.026, lng: 109.342 },
  { id: 'palangkaraya', name: 'Palangkaraya', country: 'ID', lat: -2.21, lng: 113.92 },
];

export const MALAYSIA_VIEW = { lat: 3.5, lng: 104, altitude: 1.8 } as const;
/** Region box for satellite overlays and fire detections: lat -10..12, lng 92..120. */
export const REGION_BBOX = { south: -10, west: 92, north: 12, east: 120 } as const;

export type AqiBandId =
  | 'good'
  | 'moderate'
  | 'sensitive'
  | 'unhealthy'
  | 'very_unhealthy'
  | 'hazardous';

export const AQI_BANDS: readonly {
  id: AqiBandId;
  label: string;
  max: number;
  cssVar: string;
}[] = [
  { id: 'good', label: 'Good', max: 50, cssVar: 'good' },
  { id: 'moderate', label: 'Moderate', max: 100, cssVar: 'moderate' },
  {
    id: 'sensitive',
    label: 'Unhealthy for sensitive groups',
    max: 150,
    cssVar: 'sensitive',
  },
  { id: 'unhealthy', label: 'Unhealthy', max: 200, cssVar: 'unhealthy' },
  { id: 'very_unhealthy', label: 'Very unhealthy', max: 300, cssVar: 'very-unhealthy' },
  { id: 'hazardous', label: 'Hazardous', max: Infinity, cssVar: 'hazardous' },
];

export function aqiBand(aqi: number) {
  return AQI_BANDS.find((b) => aqi <= b.max) ?? AQI_BANDS[AQI_BANDS.length - 1];
}

export interface CityReading {
  city: City;
  /** ISO time (UTC) of the model step this reading belongs to. */
  observedAt: string | null;
  usAqi: number | null;
  pm25: number | null;
  pm10: number | null;
  co: number | null;
  no2: number | null;
  so2: number | null;
  o3: number | null;
  temperature: number | null;
  windSpeed: number | null;
  windDirection: number | null;
}

export interface RegionSnapshot {
  readings: CityReading[];
  fetchedAt: string;
}

const AQ_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const WX_URL = 'https://api.open-meteo.com/v1/forecast';
const AQ_VARS = [
  'us_aqi',
  'pm2_5',
  'pm10',
  'carbon_monoxide',
  'nitrogen_dioxide',
  'sulphur_dioxide',
  'ozone',
] as const;
const WX_VARS = ['temperature_2m', 'wind_speed_10m', 'wind_direction_10m'] as const;

interface OpenMeteoPoint {
  utc_offset_seconds: number;
  current?: Record<string, number | string | null>;
}

function coords(cities: readonly City[]) {
  return {
    latitude: cities.map((c) => c.lat.toFixed(3)).join(','),
    longitude: cities.map((c) => c.lng.toFixed(3)).join(','),
  };
}

async function fetchOpenMeteo(
  base: string,
  vars: readonly string[],
  cities: readonly City[],
  signal?: AbortSignal,
): Promise<OpenMeteoPoint[]> {
  const params = new URLSearchParams({
    ...coords(cities),
    current: vars.join(','),
    timezone: 'auto',
  });
  const res = await fetch(`${base}?${params}`, { signal });
  if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
  const json = (await res.json()) as OpenMeteoPoint | OpenMeteoPoint[];
  return Array.isArray(json) ? json : [json];
}

/** Open-Meteo returns local wall time without an offset; convert to a UTC ISO string. */
function toUtcIso(local: unknown, offsetSeconds: number): string | null {
  if (typeof local !== 'string') return null;
  const ms = Date.parse(`${local}Z`);
  return Number.isNaN(ms) ? null : new Date(ms - offsetSeconds * 1000).toISOString();
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export async function fetchRegionSnapshot(
  signal?: AbortSignal,
  cities: readonly City[] = CITIES,
): Promise<RegionSnapshot> {
  const [aq, wx] = await Promise.all([
    fetchOpenMeteo(AQ_URL, AQ_VARS, cities, signal),
    // Weather is a nice-to-have: an outage there must not hide air quality.
    fetchOpenMeteo(WX_URL, WX_VARS, cities, signal).catch((err: unknown) => {
      if (signal?.aborted) throw err;
      return [] as OpenMeteoPoint[];
    }),
  ]);
  const readings = cities.map((city, i): CityReading => {
    const a = aq[i]?.current ?? {};
    const w = wx[i]?.current ?? {};
    return {
      city,
      observedAt: toUtcIso(a.time, aq[i]?.utc_offset_seconds ?? 0),
      usAqi: num(a.us_aqi),
      pm25: num(a.pm2_5),
      pm10: num(a.pm10),
      co: num(a.carbon_monoxide),
      no2: num(a.nitrogen_dioxide),
      so2: num(a.sulphur_dioxide),
      o3: num(a.ozone),
      temperature: num(w.temperature_2m),
      windSpeed: num(w.wind_speed_10m),
      windDirection: num(w.wind_direction_10m),
    };
  });
  return { readings, fetchedAt: new Date().toISOString() };
}

// ── Cache (last good snapshot survives reloads; shown as stale when old) ──

const CACHE_KEY = 'haze.region-snapshot.v1';
export const REFRESH_MS = 12 * 60 * 1000;
export const STALE_MS = 2 * 60 * 60 * 1000;

export function readCachedSnapshot(): RegionSnapshot | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as RegionSnapshot) : null;
  } catch {
    return null;
  }
}

export function writeCachedSnapshot(snapshot: RegionSnapshot) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage full or blocked: the live view still works, it just will not survive a reload.
  }
}

export function isStale(snapshot: RegionSnapshot, now = Date.now()) {
  return now - Date.parse(snapshot.fetchedAt) > STALE_MS;
}

// ── Satellite overlays (NASA GIBS) ──

export type SatelliteLayerId = 'co' | 'aod' | 'himawari';

export interface SatelliteLayer {
  id: SatelliteLayerId;
  gibsId: string;
  label: string;
  note: string;
  /** Returns the TIME value to request, which is also the observation time we show. */
  time: (now: Date) => string;
  timeLabel: (time: string) => string;
}

function daysAgo(now: Date, days: number) {
  const d = new Date(now.getTime() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Layer IDs read from the GIBS EPSG:4326/3857 WMTSCapabilities (2026-10-27).
 * Sentinel-5P/TROPOMI CO is not in GIBS and MOPITT daily CO ends 2024-11-10,
 * so CO uses AIRS L3 daily (500 hPa, roughly a week of latency).
 */
export const SATELLITE_LAYERS: readonly SatelliteLayer[] = [
  {
    id: 'himawari',
    gibsId: 'Himawari_AHI_Band13_Clean_Infrared',
    label: 'Himawari clouds (IR)',
    note: 'Geostationary infrared, every 10 min, ~1 h behind real time.',
    time: (now) => {
      const t = new Date(now.getTime() - 70 * 60_000);
      t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 10) * 10, 0, 0);
      return t.toISOString().replace('.000Z', 'Z');
    },
    timeLabel: (t) => `${t.slice(0, 10)} ${t.slice(11, 16)} UTC`,
  },
  {
    id: 'aod',
    gibsId: 'MODIS_Terra_Aerosol_Optical_Depth_3km',
    label: 'Aerosol optical depth',
    note: 'MODIS Terra daily swaths; gaps under cloud.',
    time: (now) => daysAgo(now, 1),
    timeLabel: (t) => t,
  },
  {
    id: 'co',
    gibsId: 'AIRS_L3_Carbon_Monoxide_500hPa_Volume_Mixing_Ratio_Daily_Day',
    label: 'CO column (AIRS)',
    note: 'Mid-troposphere CO, daily, about 8 days behind.',
    time: (now) => daysAgo(now, 8),
    timeLabel: (t) => t,
  },
];

export function gibsImageUrl(
  layer: SatelliteLayer,
  time: string,
  width = 1024,
): string {
  const { west, south, east, north } = REGION_BBOX;
  const height = Math.round((width * (north - south)) / (east - west));
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.1.1',
    LAYERS: layer.gibsId,
    SRS: 'EPSG:4326',
    BBOX: `${west},${south},${east},${north}`,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
    TIME: time,
  });
  return `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?${params}`;
}

/** Coastlines and borders over the region, for both the globe and the flat map. */
export function gibsReferenceUrl(width = 1536): string {
  const { west, south, east, north } = REGION_BBOX;
  const height = Math.round((width * (north - south)) / (east - west));
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.1.1',
    LAYERS: 'Reference_Features_15m,Coastlines_15m',
    SRS: 'EPSG:4326',
    BBOX: `${west},${south},${east},${north}`,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
  });
  return `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?${params}`;
}

/** Dark-ish base relief tiles (Web Mercator XYZ), shared by globe and flat map. */
export const GIBS_BASE_TILE = (x: number, y: number, z: number) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`;
export const GIBS_BASE_TEMPLATE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';
export const GIBS_BASE_MAX_ZOOM = 8;

// ── Active fires (NASA FIRMS) ──

export interface FireHotspot {
  lat: number;
  lng: number;
  /** Fire radiative power, MW. */
  frp: number | null;
  acquiredAt: string | null;
  confidence: string | null;
}

export type FireResult =
  | { status: 'no-key' }
  | { status: 'ok'; hotspots: FireHotspot[]; fetchedAt: string; source: string }
  | { status: 'error'; message: string };

const FIRMS_KEY = (import.meta.env.VITE_FIRMS_MAP_KEY as string | undefined)?.trim();
const FIRMS_SOURCE = 'VIIRS_NOAA20_NRT';

export function hasFirmsKey() {
  return Boolean(FIRMS_KEY);
}

function parseCsv(text: string): Record<string, string>[] {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  if (!head) return [];
  const cols = head.split(',');
  return rows.map((row) => {
    const cells = row.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

/** VIIRS detections over the region for the last 2 days. */
export async function fetchFires(signal?: AbortSignal): Promise<FireResult> {
  if (!FIRMS_KEY) return { status: 'no-key' };
  const { west, south, east, north } = REGION_BBOX;
  // Same-origin proxy (see vite.config.ts); a static host must forward /firms-api to FIRMS /api.
  const url = `/firms-api/area/csv/${encodeURIComponent(
    FIRMS_KEY,
  )}/${FIRMS_SOURCE}/${west},${south},${east},${north}/2`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`FIRMS responded ${res.status}`);
    const text = await res.text();
    if (!text.startsWith('latitude')) throw new Error(text.slice(0, 120));
    const hotspots = parseCsv(text).map((r): FireHotspot => {
      const hhmm = (r.acq_time ?? '').padStart(4, '0');
      return {
        lat: Number(r.latitude),
        lng: Number(r.longitude),
        frp: r.frp ? Number(r.frp) : null,
        acquiredAt: r.acq_date
          ? `${r.acq_date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`
          : null,
        confidence: r.confidence ?? null,
      };
    });
    return {
      status: 'ok',
      hotspots: hotspots.filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng)),
      fetchedAt: new Date().toISOString(),
      source: 'NASA FIRMS VIIRS NOAA-20 (NRT)',
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

export function hotspotsInLast(hotspots: FireHotspot[], hours: number, now = Date.now()) {
  return hotspots.filter(
    (h) => h.acquiredAt && now - Date.parse(h.acquiredAt) <= hours * 3_600_000,
  ).length;
}

/** Fog density for the landing page: 0 at clean air, 1 by PM2.5 ≈ 150, capped at 0.85. */
export function hazeDensity(pm25: number | null): number {
  if (pm25 === null) return 0.35;
  return Math.min(0.85, Math.max(0.1, pm25 / 150));
}

export function compass(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) + 360) / 45) % 8];
}
