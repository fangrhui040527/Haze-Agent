/** Shared source, location and evidence-check contracts for collection and display. */

export type SourceKind =
  | 'ground_monitor'
  | 'satellite'
  | 'forecast_model'
  | 'government'
  | 'news'
  | 'community'
  | 'low_cost_sensor'
  | 'data_platform';

/** How a piece of evidence was produced. Never mix these up in the UI. */
export type EvidenceKind = 'observation' | 'forecast' | 'modeled' | 'report';

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

export type CheckResult = 'pass' | 'warn' | 'fail' | 'pending';

export interface EvidenceCheck {
  id: string;
  label: string;
  result: CheckResult;
  detail: string;
}
