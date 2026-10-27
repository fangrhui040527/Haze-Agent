import {
  aqiBand,
  compass,
  type CityReading,
  type FireResult,
  type SatelliteLayerId,
} from '../../shared/data/airQuality.ts';

export type PrimaryLayer = 'aqi' | 'co' | 'temp';

export interface LayerState {
  primary: PrimaryLayer;
  wind: boolean;
  fires: boolean;
  satellite: SatelliteLayerId | null;
}

export const DEFAULT_LAYERS: LayerState = {
  primary: 'aqi',
  wind: true,
  fires: true,
  satellite: null,
};

/** Props shared by the 3D globe and the 2D map so either can render the same scene. */
export interface RegionViewProps {
  readings: CityReading[];
  fires: FireResult | null;
  layers: LayerState;
  selectedId: string;
  onSelect: (cityId: string) => void;
  /** Bumped by the "Reset to Malaysia" button. */
  resetKey: number;
  /** Satellite TIME value to request for the active overlay. */
  satelliteTime: string | null;
}

// CO in µg/m³ (CAMS surface). Breaks are for colouring only; CO is NOT an AQI.
export const CO_BREAKS = [250, 400, 700, 1200] as const;
export const TEMP_BREAKS = [24, 27, 30, 33] as const;

function step(value: number, breaks: readonly number[]) {
  const i = breaks.findIndex((b) => value < b);
  return (i === -1 ? breaks.length : i) + 1;
}

/** CSS custom property (without var()) for a reading's marker colour on the active layer. */
export function markerVar(r: CityReading, layer: PrimaryLayer): string {
  if (layer === 'aqi') {
    return r.usAqi === null ? '--band-unknown' : `--band-${aqiBand(r.usAqi).cssVar}`;
  }
  if (layer === 'co') {
    return r.co === null ? '--band-unknown' : `--scale-co-${step(r.co, CO_BREAKS)}`;
  }
  return r.temperature === null
    ? '--band-unknown'
    : `--scale-temp-${step(r.temperature, TEMP_BREAKS)}`;
}

/** Short value text shown on the marker label. Missing values read "no data", never 0. */
export function markerValue(r: CityReading, layer: PrimaryLayer): string {
  if (layer === 'aqi') return r.usAqi === null ? 'no data' : `AQI ${Math.round(r.usAqi)}`;
  if (layer === 'co') return r.co === null ? 'no data' : `CO ${Math.round(r.co)}`;
  return r.temperature === null ? 'no data' : `${r.temperature.toFixed(1)}°C`;
}

/** Full sentence for screen readers and tooltips. */
export function describeReading(r: CityReading): string {
  const parts = [r.city.name];
  parts.push(
    r.usAqi === null
      ? 'US AQI no data'
      : `US AQI ${Math.round(r.usAqi)}, ${aqiBand(r.usAqi).label}`,
  );
  if (r.pm25 !== null) parts.push(`PM2.5 ${r.pm25.toFixed(1)} µg/m³`);
  if (r.co !== null) parts.push(`CO ${Math.round(r.co)} µg/m³`);
  if (r.temperature !== null) parts.push(`${r.temperature.toFixed(1)} °C`);
  if (r.windSpeed !== null && r.windDirection !== null) {
    parts.push(`wind ${Math.round(r.windSpeed)} km/h from ${compass(r.windDirection)}`);
  }
  return parts.join(', ');
}

/** Read a token's computed value, for renderers (WebGL, Leaflet SVG) that need real colours. */
export function readToken(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || '#8e877a';
}

export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Low-power or reduced-motion devices get the flat map by default. */
export function prefersFlatMap(): boolean {
  if (!hasWebGL()) return true;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  if (nav.connection?.saveData) return true;
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 2) return true;
  return navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 2;
}
