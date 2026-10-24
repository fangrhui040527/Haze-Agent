/**
 * Domain types for haze information shown in the UI.
 *
 * These describe what the FRONTEND needs. When the backend (or the Zetaris-backed API)
 * is ready, map its responses into these types inside the data adapter
 * (src/services/data/) so the rest of the app does not change.
 */

export type CategoryId =
  | 'reading'
  | 'hotspot'
  | 'forecast'
  | 'advisory'
  | 'health'
  | 'disruption'
  | 'news'
  | 'community'
  | 'sensor_issue';

export type ItemStatus =
  'verified' | 'partial' | 'unverified' | 'conflicting' | 'stale' | 'retracted';

export type SourceKind =
  | 'ground_monitor'
  | 'satellite'
  | 'forecast_model'
  | 'government'
  | 'news'
  | 'community'
  | 'low_cost_sensor';

/** How a piece of evidence was produced. Never mix these up in the UI. */
export type EvidenceKind = 'observation' | 'forecast' | 'modeled' | 'report';

export type PollutantId = 'pm25' | 'pm10' | 'o3' | 'no2' | 'co' | 'so2';

export type BandId =
  | 'good'
  | 'moderate'
  | 'sensitive'
  | 'unhealthy'
  | 'very_unhealthy'
  | 'hazardous';

export type Trend = 'up' | 'down' | 'flat';

export type PopulationBand = 'small' | 'medium' | 'large' | 'mega';

export interface Location {
  id: string;
  name: string;
  region: string;
  country: string;
  countryCode: string;
  lat: number;
  lon: number;
  /** IANA time zone, e.g. "Asia/Jakarta". Times are stored in UTC and shown in this zone. */
  timeZone: string;
  /** Name of the local official air-quality standard (label only in the demo). */
  aqiStandard: string;
  populationBand: PopulationBand;
}

export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  evidenceKind: EvidenceKind;
  organisation: string;
  /** Human-readable update cadence, e.g. "hourly", "2 passes per day". */
  cadence: string;
  licenceNote: string;
  reliabilityNote: string;
  url: string;
}

export interface Measurement {
  pollutant: PollutantId;
  /** null = no data. Never treat null as zero. */
  value: number | null;
  unit: 'µg/m³' | 'ppb' | 'mg/m³';
  averaging: '1h' | '24h';
}

export interface Weather {
  windSpeedKmh: number | null;
  windDirection: string | null;
  humidityPct: number | null;
  rainMm: number | null;
  visibilityKm: number | null;
  temperatureC: number | null;
}

export interface FireInfo {
  hotspotCount: number;
  maxFrpMw: number | null;
  landType: 'peat' | 'forest' | 'agriculture' | 'grassland' | 'mixed';
  detectionConfidence: 'low' | 'nominal' | 'high';
}

export interface ForecastInfo {
  validFrom: string;
  validTo: string;
  expectedPm25: number | null;
  direction: 'worsening' | 'improving' | 'steady';
}

export type ImpactKind =
  | 'school_closure'
  | 'flight_delay'
  | 'hospital_visits'
  | 'event_cancelled'
  | 'outdoor_work_advisory'
  | 'transport';

export interface Impact {
  kind: ImpactKind;
  description: string;
  count: number | null;
}

export interface ItemSourceRef {
  sourceId: string;
  role: 'primary' | 'supporting' | 'conflicting';
  measuredAt: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  validUntil: string | null;
  excerpt: string;
}

export type CheckResult = 'pass' | 'warn' | 'fail' | 'pending';

export interface EvidenceCheck {
  id: string;
  label: string;
  result: CheckResult;
  detail: string;
}

export type AgentId =
  | 'manager'
  | 'hazeops'
  | 'worldmodel'
  | 'hmem'
  | 'evidencecritic'
  | 'workershield';

export interface AgentResult {
  agent: AgentId;
  outcome: 'ok' | 'warning' | 'failed' | 'skipped';
  summary: string;
  durationMs: number;
}

export interface TimelineEntry {
  at: string;
  label: string;
  agent: AgentId | null;
}

export interface HazeItem {
  id: string;
  /** Always true for demo data. The UI shows a DEMO banner while any fictional data is displayed. */
  fictional: boolean;
  locationId: string;
  category: CategoryId;
  headline: string;
  /** One line for the table cell. */
  summary: string;
  /** Full text paragraphs for the detail page. */
  details: string[];
  status: ItemStatus;
  /** When the underlying thing was measured / happened (UTC ISO). */
  observedAt: string;
  /** When this record was last changed (UTC ISO). */
  updatedAt: string;
  revision: number;
  measurements: Measurement[];
  trend: Trend | null;
  weather: Weather | null;
  fire: FireInfo | null;
  forecast: ForecastInfo | null;
  impacts: Impact[];
  sources: ItemSourceRef[];
  checks: EvidenceCheck[];
  agentResults: AgentResult[];
  timeline: TimelineEntry[];
  relatedIds: string[];
  tags: string[];
}

export interface ItemDetail {
  item: HazeItem;
  location: Location | null;
  /** Sources referenced by the item, resolved from their ids (missing ones are omitted). */
  sources: Source[];
  related: HazeItem[];
}

export type ConnectionStatus = 'connecting' | 'live' | 'offline' | 'error';
