import { rankItems, type RankedItem } from '../features/live-table/ranking.ts';
import {
  BAND_STANDARD_LABEL,
  bandLabel,
  itemBand,
  itemPm25,
} from '../shared/lib/bands.ts';
import { STATUS_LABELS } from '../shared/lib/labels.ts';
import { formatDateTime, timeAgo } from '../shared/lib/time.ts';
import type { Citation } from '../shared/types/agents.ts';
import type { ChatIntent, DemoDataset } from '../shared/types/dataset.ts';
import type { HazeItem, Location } from '../shared/types/domain.ts';
import { LOCATION_SEEDS } from './generator/locations.ts';

/**
 * Builds the MOCK agents' answer from the demo dataset and the chat templates.
 * The real backend replaces all of this; it only exists so the demo answers make sense.
 */

export interface ComposedAnswer {
  intent: ChatIntent;
  paragraphs: string[];
  citations: Citation[];
  locations: Location[];
  itemCount: number;
  sourceCount: number;
}

const normalize = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function findLocations(question: string, dataset: DemoDataset): Location[] {
  const q = normalize(question);
  const byName = dataset.locations.filter(
    (l) => q.includes(normalize(l.name)) || q.includes(l.id.replace(/-/g, ' ')),
  );
  if (byName.length > 0) {
    // Keep the order in which they appear in the question.
    return byName.sort(
      (a, b) => q.indexOf(normalize(a.name)) - q.indexOf(normalize(b.name)),
    );
  }
  const byCountry = dataset.locations.filter((l) =>
    q.includes(normalize(l.country)),
  );
  if (byCountry.length > 0) return byCountry;
  return dataset.locations.filter((l) => q.includes(normalize(l.region)));
}

function detectIntent(question: string, dataset: DemoDataset): ChatIntent {
  const q = ` ${normalize(question)} `;
  const order: ChatIntent[] = [
    'compare',
    'forecast',
    'health',
    'cause',
    'sources',
    'changes',
  ];
  for (const intent of order) {
    const script = dataset.chatScripts.find((s) => s.intent === intent);
    if (script?.keywords.some((k) => q.includes(normalize(k)))) return intent;
  }
  return 'overview';
}

function fill(
  template: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key];
    return value === null || value === undefined || value === ''
      ? 'no data'
      : String(value);
  });
}

const fmt = (n: number | null) => (n === null ? null : String(Math.round(n)));

export function composeAnswer(
  question: string,
  dataset: DemoDataset,
  nowMs: number,
  focusItemId: string | null = null,
): ComposedAnswer {
  const ranked = rankItems(dataset.items, dataset.locations, nowMs).filter(
    (r) => r.item.status !== 'retracted',
  );
  const focus = focusItemId
    ? (dataset.items.find((i) => i.id === focusItemId) ?? null)
    : null;

  let locations = findLocations(question, dataset);
  if (focus) {
    const focusLocation = dataset.locations.find(
      (l) => l.id === focus.locationId,
    );
    if (focusLocation)
      locations = [
        focusLocation,
        ...locations.filter((l) => l.id !== focusLocation.id),
      ];
  }
  const intent = detectIntent(question, dataset);

  // No place named: use the top-ranked places.
  const topPlaces = [
    ...new Map(ranked.map((r) => [r.item.locationId, r.location])).values(),
  ].filter((l): l is Location => l !== null);
  if (locations.length === 0)
    locations = topPlaces.slice(0, intent === 'compare' ? 2 : 1);
  if (intent === 'compare' && locations.length < 2) {
    locations = [
      ...locations,
      ...topPlaces.filter((l) => !locations.includes(l)),
    ].slice(0, 2);
  }

  const best = (
    locationId: string,
    pred: (r: RankedItem) => boolean = () => true,
  ) => ranked.find((r) => r.item.locationId === locationId && pred(r)) ?? null;
  const withPm = (r: RankedItem) =>
    itemPm25(r.item) !== null && r.item.category !== 'forecast';

  const primary = locations[0];
  const used: HazeItem[] = [];
  const use = (r: RankedItem | null) => {
    if (r && !used.includes(r.item)) used.push(r.item);
    return r;
  };

  const templates =
    dataset.chatScripts.find((s) => s.intent === intent)?.templates ?? [];
  const vars: Record<string, string | number | null> = {};
  let primaryPm: number | null = null;

  if (primary) {
    const main = use(best(primary.id, withPm) ?? best(primary.id));
    const pm = main ? itemPm25(main.item) : null;
    primaryPm = pm;
    const band = main ? itemBand(main.item) : null;
    Object.assign(vars, {
      location: primary.name,
      pm25: fmt(pm),
      band: band ? bandLabel(band) : 'unknown',
      trend:
        main?.item.trend === 'up'
          ? 'rising'
          : main?.item.trend === 'down'
            ? 'falling'
            : 'steady',
      time: main
        ? formatDateTime(main.item.observedAt, primary.timeZone)
        : null,
      headline: main?.item.headline ?? null,
      status: main ? STATUS_LABELS[main.item.status] : null,
      standardNote: `${BAND_STANDARD_LABEL}; local standard: ${primary.aqiStandard}`,
      driver:
        LOCATION_SEEDS.find((l) => l.location.id === primary.id)?.profile
          .driver ?? 'local sources',
    });

    if (intent === 'forecast') {
      const f = use(best(primary.id, (r) => r.item.category === 'forecast'));
      Object.assign(vars, {
        forecastDirection: f?.item.forecast?.direction ?? null,
        forecastPm25: fmt(f?.item.forecast?.expectedPm25 ?? null),
        validTo: f?.item.forecast
          ? formatDateTime(f.item.forecast.validTo, primary.timeZone)
          : null,
      });
    }
    if (intent === 'cause') {
      const h = use(best(primary.id, (r) => r.item.category === 'hotspot'));
      Object.assign(vars, {
        hotspots: h?.item.fire?.hotspotCount ?? null,
        landType: h?.item.fire?.landType ?? null,
      });
    }
    if (intent === 'health') {
      const guidance = dataset.sources.find(
        (s) =>
          s.kind === 'government' &&
          main?.item.sources.some((r) => r.sourceId === s.id),
      );
      vars.guidanceSource =
        guidance?.name ?? `the health authority for ${primary.name}`;
    }
    if (intent === 'sources' && main) {
      const names = main.item.sources
        .map(
          (r) =>
            dataset.sources.find((s) => s.id === r.sourceId)?.name ??
            `${r.sourceId} (unavailable)`,
        )
        .join(', ');
      const passed = main.item.checks.filter((c) => c.result === 'pass').length;
      Object.assign(vars, {
        sourceCount: main.item.sources.length,
        sourceNames: names,
        checksSummary: `${passed} of ${main.item.checks.length} checks passed (${STATUS_LABELS[main.item.status]})`,
      });
    }
  }

  if (intent === 'compare' && locations[1]) {
    const second = locations[1];
    const b = use(best(second.id, withPm) ?? best(second.id));
    const bandB = b ? itemBand(b.item) : null;
    // Compare the two readings actually quoted above, so the sentence never contradicts the numbers.
    const pmA = primaryPm;
    const pmB = b ? itemPm25(b.item) : null;
    Object.assign(vars, {
      locationB: second.name,
      pm25B: fmt(pmB),
      bandB: bandB ? bandLabel(bandB) : 'unknown',
      comparison:
        pmA === null || pmB === null
          ? 'One of the two places has no PM2.5 reading, so they cannot be compared directly.'
          : pmA === pmB
            ? 'Both readings are the same.'
            : `Of the two readings above, ${pmA > pmB ? primary?.name : second.name} has the higher PM2.5.`,
    });
  }

  if (intent === 'changes') {
    const sixHoursAgo = nowMs - 6 * 3_600_000;
    const scope =
      locations.length > 0 && findLocations(question, dataset).length > 0
        ? new Set(locations.map((l) => l.id))
        : null;
    const recent = dataset.items
      .filter(
        (i) =>
          Date.parse(i.updatedAt) >= sixHoursAgo &&
          (!scope || scope.has(i.locationId)),
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const latest = recent[0];
    if (latest) used.push(latest);
    Object.assign(vars, {
      updates: recent.length,
      scopeNote: scope
        ? ` for ${locations.map((l) => l.name).join(', ')}`
        : ' across all locations',
      headline: latest?.headline ?? null,
      timeAgo: latest ? timeAgo(latest.updatedAt, nowMs) : null,
    });
  }

  const paragraphs = templates.map((t) => fill(t, vars));
  paragraphs.push('Demo answer: generated from fictional data by mock agents.');

  const citations: Citation[] = used.slice(0, 4).map((item) => ({
    label: `${dataset.locations.find((l) => l.id === item.locationId)?.name ?? item.locationId}: ${item.headline.slice(0, 60)}`,
    itemId: item.id,
  }));

  return {
    intent,
    paragraphs,
    citations,
    locations,
    itemCount: used.length,
    sourceCount: used.reduce((sum, i) => sum + i.sources.length, 0),
  };
}
