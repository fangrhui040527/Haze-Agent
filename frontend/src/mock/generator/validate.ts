import {
  DATASET_SCHEMA_VERSION,
  type DemoDataset,
} from '../../shared/types/dataset.ts';
import type { CategoryId, ItemStatus } from '../../shared/types/domain.ts';

/**
 * Checks an imported JSON file before it replaces the demo data.
 * Hand-written (no schema library) and deliberately forgiving about extra fields.
 * Returns readable errors like `items[3].locationId: unknown location "xyz"`.
 */

export type ValidationResult =
  | { ok: true; dataset: DemoDataset; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const CATEGORIES: CategoryId[] = [
  'reading',
  'hotspot',
  'forecast',
  'advisory',
  'health',
  'disruption',
  'news',
  'community',
  'sensor_issue',
];
const STATUSES: ItemStatus[] = [
  'verified',
  'partial',
  'unverified',
  'conflicting',
  'stale',
  'retracted',
];
const MAX_ERRORS = 50;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isDate = (v: unknown) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v));

function validTimeZone(tz: unknown): boolean {
  if (typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateDataset(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(msg);
  };

  if (!isObject(input))
    return { ok: false, errors: ['The file is not a JSON object.'], warnings };
  const legacySchema = input.schemaVersion === 'hazewatch.demo.v1';
  if (input.schemaVersion !== DATASET_SCHEMA_VERSION && !legacySchema) {
    err(
      `schemaVersion: expected "${DATASET_SCHEMA_VERSION}", got ${JSON.stringify(input.schemaVersion)}`,
    );
  }
  if (input.fictional !== true)
    err('fictional: must be true (demo data must be labelled as fictional)');
  for (const key of ['locations', 'sources', 'items', 'chatScripts'] as const) {
    if (!Array.isArray(input[key])) err(`${key}: must be an array`);
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  const locations = input.locations as unknown[];
  const sources = input.sources as unknown[];
  const items = input.items as unknown[];

  const locationIds = new Set<string>();
  locations.forEach((l, i) => {
    if (!isObject(l)) return err(`locations[${i}]: must be an object`);
    for (const key of [
      'id',
      'name',
      'region',
      'country',
      'aqiStandard',
    ] as const) {
      if (typeof l[key] !== 'string' || l[key] === '')
        err(`locations[${i}].${key}: required text`);
    }
    if (typeof l.lat !== 'number' || typeof l.lon !== 'number')
      err(`locations[${i}]: lat/lon must be numbers`);
    if (!validTimeZone(l.timeZone))
      err(
        `locations[${i}].timeZone: not a valid IANA time zone (${JSON.stringify(l.timeZone)})`,
      );
    if (typeof l.id === 'string') {
      if (locationIds.has(l.id)) err(`locations[${i}].id: duplicate "${l.id}"`);
      locationIds.add(l.id);
    }
  });

  const sourceIds = new Set<string>();
  sources.forEach((s, i) => {
    if (!isObject(s)) return err(`sources[${i}]: must be an object`);
    for (const key of [
      'id',
      'name',
      'kind',
      'evidenceKind',
      'organisation',
    ] as const) {
      if (typeof s[key] !== 'string' || s[key] === '')
        err(`sources[${i}].${key}: required text`);
    }
    if (typeof s.id === 'string') sourceIds.add(s.id);
  });

  const itemIds = new Set<string>();
  items.forEach((it, i) => {
    if (!isObject(it)) return err(`items[${i}]: must be an object`);
    const at = `items[${i}]`;
    if (typeof it.id !== 'string' || it.id === '')
      err(`${at}.id: required text`);
    else if (itemIds.has(it.id)) err(`${at}.id: duplicate "${it.id}"`);
    else itemIds.add(it.id);
    if (typeof it.locationId !== 'string' || !locationIds.has(it.locationId)) {
      err(
        `${at}.locationId: unknown location ${JSON.stringify(it.locationId)}`,
      );
    }
    if (!CATEGORIES.includes(it.category as CategoryId))
      err(`${at}.category: must be one of ${CATEGORIES.join(', ')}`);
    if (!STATUSES.includes(it.status as ItemStatus))
      err(`${at}.status: must be one of ${STATUSES.join(', ')}`);
    if (typeof it.headline !== 'string') err(`${at}.headline: required text`);
    if (typeof it.summary !== 'string') err(`${at}.summary: required text`);
    if (!isDate(it.observedAt)) err(`${at}.observedAt: must be an ISO date`);
    if (!isDate(it.updatedAt)) err(`${at}.updatedAt: must be an ISO date`);
    for (const key of [
      'details',
      'measurements',
      'impacts',
      'sources',
      'checks',
      'agentResults',
      'timeline',
      'relatedIds',
      'tags',
    ] as const) {
      if (!Array.isArray(it[key])) err(`${at}.${key}: must be an array`);
    }
    if (Array.isArray(it.sources)) {
      it.sources.forEach((ref, j) => {
        if (
          isObject(ref) &&
          typeof ref.sourceId === 'string' &&
          !sourceIds.has(ref.sourceId)
        ) {
          warnings.push(
            `${at}.sources[${j}]: source "${ref.sourceId}" is not in the source list (shown as unavailable)`,
          );
        }
      });
    }
  });

  if (errors.length >= MAX_ERRORS)
    errors.push(`…stopped after ${MAX_ERRORS} errors.`);
  return errors.length > 0
    ? { ok: false, errors, warnings }
    : {
        ok: true,
        dataset: {
          ...input,
          schemaVersion: DATASET_SCHEMA_VERSION,
        } as unknown as DemoDataset,
        warnings,
      };
}
