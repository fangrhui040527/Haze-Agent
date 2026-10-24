import type {
  CategoryId,
  CheckResult,
  ImpactKind,
  ItemStatus,
  PollutantId,
  SourceKind,
  EvidenceKind,
} from '../types/domain.ts';

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  reading: 'Air-quality reading',
  hotspot: 'Fire hotspot',
  forecast: 'Forecast',
  advisory: 'Official advisory',
  health: 'Health guidance',
  disruption: 'Disruption',
  news: 'News report',
  community: 'Community report',
  sensor_issue: 'Sensor issue',
};

export const STATUS_LABELS: Record<ItemStatus, string> = {
  verified: 'Verified',
  partial: 'Partially verified',
  unverified: 'Unverified',
  conflicting: 'Conflicting',
  stale: 'Stale',
  retracted: 'Retracted',
};

export const STATUS_DESCRIPTIONS: Record<ItemStatus, string> = {
  verified: 'All evidence checks passed.',
  partial: 'Some checks passed; others raised warnings.',
  unverified: 'Not yet checked, or only one unconfirmed source.',
  conflicting: 'Sources disagree with each other.',
  stale: 'The newest source is too old to rely on.',
  retracted: 'Withdrawn: a source corrected or withdrew the information.',
};

export const POLLUTANT_LABELS: Record<PollutantId, string> = {
  pm25: 'PM2.5',
  pm10: 'PM10',
  o3: 'O₃',
  no2: 'NO₂',
  co: 'CO',
  so2: 'SO₂',
};

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  ground_monitor: 'Ground monitor',
  satellite: 'Satellite',
  forecast_model: 'Forecast model',
  government: 'Government agency',
  news: 'News outlet',
  community: 'Community report',
  low_cost_sensor: 'Low-cost sensor',
};

export const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
  observation: 'Observation',
  forecast: 'Forecast',
  modeled: 'Modeled',
  report: 'Report (unmeasured)',
};

export const CHECK_RESULT_LABELS: Record<CheckResult, string> = {
  pass: 'Passed',
  warn: 'Warning',
  fail: 'Failed',
  pending: 'Pending',
};

export const IMPACT_LABELS: Record<ImpactKind, string> = {
  school_closure: 'School closures',
  flight_delay: 'Flight delays',
  hospital_visits: 'Hospital visits',
  event_cancelled: 'Events cancelled',
  outdoor_work_advisory: 'Outdoor-work advisory',
  transport: 'Transport',
};
