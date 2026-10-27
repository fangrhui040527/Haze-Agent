import type { Location, Source, EvidenceCheck } from './haze-evidence.js';
export type {
  SourceKind,
  EvidenceKind,
  PopulationBand,
  Location,
  Source,
  CheckResult,
  EvidenceCheck,
} from './haze-evidence.js';

/**
 * Domain types for haze information shown in the UI.
 *
 * Shared by the dashboard API and browser clients. The backend projects retained
 * World Model records into these presentation contracts.
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

export type PollutantId = 'pm25' | 'pm10' | 'o3' | 'no2' | 'co' | 'so2';

export type BandId =
  | 'good'
  | 'moderate'
  | 'sensitive'
  | 'unhealthy'
  | 'very_unhealthy'
  | 'hazardous';

export type Trend = 'up' | 'down' | 'flat';

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
  /** 'unknown' for real satellite detections: a hotspot alone does not show the land type. */
  landType:
    'peat' | 'forest' | 'agriculture' | 'grassland' | 'mixed' | 'unknown';
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

export type AgentId =
  'manager' | 'hazeops' | 'worldmodel' | 'evidencecritic' | 'workershield';

/** Active agents plus the retired H-MEM, which only historical records may carry. */
export type RecordedAgentId = AgentId | 'hmem';

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

/** A dashboard view of the authoritative World Model. */
export interface DataSnapshot {
  items: HazeItem[];
  locations: Location[];
  sources: Source[];
  asOf: string;
  fictional: boolean;
}

export type LiveUpdate =
  | { kind: 'upsert'; items: HazeItem[]; asOf: string }
  | { kind: 'reset'; snapshot: DataSnapshot };
