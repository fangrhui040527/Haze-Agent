import type { Citation } from '../../../frontend/src/shared/types/agents.ts';
import type {
  HazeItem,
  Location,
} from '../../../frontend/src/shared/types/domain.ts';
import type { RecalledExchange } from '../memory/memory.ts';

/**
 * Template answers built only from projected World Model items. No AI model writes
 * these sentences (WorkerShield is not connected), every number comes from a cited
 * item, and health questions are not answered with advice (Spec §8.3: no free-form
 * health or safety claims).
 */

export type Intent =
  'overview' | 'forecast' | 'cause' | 'compare' | 'sources' | 'health';

const INTENT_WORDS: [Intent, RegExp][] = [
  [
    'health',
    /\b(health|safe|unsafe|mask|asthma|outdoor|exercise|children|school|work outside)\b/i,
  ],
  [
    'forecast',
    /\b(forecast|tomorrow|later|tonight|next|will|expect|predict)\b/i,
  ],
  [
    'cause',
    /\b(fire|fires|hotspot|hotspots|burn|burning|cause|why|where.*smoke|smoke from)\b/i,
  ],
  ['compare', /\b(compare|versus|vs\.?|than|worse|better)\b/i],
  [
    'sources',
    /\b(source|sources|data from|how do you know|evidence|sensor|station)\b/i,
  ],
];

export function detectIntent(question: string, locationCount: number): Intent {
  for (const [intent, pattern] of INTENT_WORDS) {
    if (pattern.test(question)) {
      if (intent === 'compare' && locationCount < 2) continue;
      return intent;
    }
  }
  return locationCount >= 2 ? 'compare' : 'overview';
}

const fold = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function findLocations(
  question: string,
  locations: readonly Location[],
): Location[] {
  const text = fold(question);
  return locations
    .map((location) => ({ location, at: text.indexOf(fold(location.name)) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((m) => m.location);
}

export const round1 = (v: number | null | undefined) =>
  v === null || v === undefined
    ? 'no value'
    : `${Math.round(v * 10) / 10} µg/m³`;

export const pm25 = (item: HazeItem) =>
  item.measurements.find((m) => m.pollutant === 'pm25')?.value ?? null;

export const STATUS_WORDS: Record<HazeItem['status'], string> = {
  verified: 'verified',
  partial: 'checked by HazeOps, not independently verified',
  unverified: 'unverified',
  conflicting: 'conflicting',
  stale: 'stale',
  retracted: 'retracted',
};

function cite(item: HazeItem, citations: Citation[]): string {
  if (!citations.some((c) => c.itemId === item.id)) {
    citations.push({ label: item.headline, itemId: item.id });
  }
  return `[${citations.findIndex((c) => c.itemId === item.id) + 1}]`;
}

/** A sensor reading near a place, with its own distance (it may be filed under another city). */
export interface NearbyReading {
  item: HazeItem;
  stationName: string;
  km: number;
}

export const NEARBY_SENSOR_KM = 20;

function placeSummary(
  place: Location,
  items: HazeItem[],
  nearby: NearbyReading[],
  citations: Citation[],
): string[] {
  const here = items.filter((i) => i.locationId === place.id);
  const observed = nearby
    .filter((n) => n.item.status !== 'stale')
    .sort((a, b) => a.km - b.km)
    .slice(0, 3);
  const modeled = here.find((i) => i.id === `hz-modeled-${place.id}`);
  const forecast = here.find((i) => i.id === `hz-forecast-${place.id}`);
  const hotspots = here.find((i) => i.id === `hz-hotspots-${place.id}`);
  const lines: string[] = [];

  if (observed.length > 0) {
    lines.push(
      `Sensors within ${NEARBY_SENSOR_KM} km of ${place.name}: ${observed
        .map(
          (n) =>
            `${round1(pm25(n.item))} at ${n.stationName} (${n.km.toFixed(1)} km away, ${STATUS_WORDS[n.item.status]}) ${cite(n.item, citations)}`,
        )
        .join('; ')}.`,
    );
  } else {
    lines.push(
      `No fresh ground sensor reading is on record within ${NEARBY_SENSOR_KM} km of ${place.name}.`,
    );
  }
  if (modeled) {
    lines.push(
      `The CAMS model estimates ${round1(pm25(modeled))} for the ~45 km cell around ${place.name} (a model, not a sensor; ${STATUS_WORDS[modeled.status]}) ${cite(modeled, citations)}.`,
    );
  }
  if (forecast?.forecast) {
    lines.push(
      `Model forecast for the next 24 h: ${forecast.forecast.direction}, peaking near ${round1(forecast.forecast.expectedPm25)} ${cite(forecast, citations)}.`,
    );
  }
  if (hotspots?.fire) {
    lines.push(
      `Satellites detected ${hotspots.fire.hotspotCount} fire hotspot(s) within 150 km in the last 24 h ${cite(hotspots, citations)}. A hotspot is not a confirmed fire and does not show where smoke came from.`,
    );
  }
  return lines;
}

export interface ComposedAnswer {
  paragraphs: string[];
  citations: Citation[];
  summary: string;
}

export function composeAnswer(input: {
  question: string;
  intent: Intent;
  places: Location[];
  defaulted: boolean;
  items: HazeItem[];
  nearby: Map<string, NearbyReading[]>;
  recalled: RecalledExchange[];
  refreshNote: string | null;
}): ComposedAnswer {
  const { intent, places, items } = input;
  const citations: Citation[] = [];
  const paragraphs: string[] = [];
  const first = places[0];

  if (!first) {
    return {
      paragraphs: [
        'No configured locations are available yet, so there is nothing to report.',
      ],
      citations,
      summary: 'No locations configured.',
    };
  }
  if (input.defaulted) {
    paragraphs.push(
      `You did not name a place I recognise, so this answer is for ${first.name}, the first configured location.`,
    );
  }

  if (intent === 'health') {
    paragraphs.push(
      'HazeWatch does not give health or safety advice. The agent that would explain what readings mean for people outdoors, using official guidance only (WorkerShield), is not connected yet. Please follow official guidance, such as Malaysia’s Department of Environment and Ministry of Health advisories.',
    );
    paragraphs.push(
      ...placeSummary(
        first,
        items,
        input.nearby.get(first.id) ?? [],
        citations,
      ),
    );
  } else if (intent === 'compare' && places.length >= 2) {
    for (const place of places.slice(0, 3)) {
      paragraphs.push(
        `${place.name}: ${placeSummary(place, items, input.nearby.get(place.id) ?? [], citations).join(' ')}`,
      );
    }
    paragraphs.push(
      'Compare like with like: a sensor reading, a model estimate and a forecast are different kinds of evidence.',
    );
  } else if (intent === 'forecast') {
    const forecast = items.find((i) => i.id === `hz-forecast-${first.id}`);
    if (forecast?.forecast) {
      paragraphs.push(
        `For ${first.name}, the CAMS model expects PM2.5 to be ${forecast.forecast.direction} over the next 24 hours, peaking near ${round1(forecast.forecast.expectedPm25)} ${cite(forecast, citations)}.`,
        'This is a regional model forecast, not an observation, and it has not been checked against sensors.',
      );
    } else {
      paragraphs.push(`No forecast is on record for ${first.name} yet.`);
    }
  } else if (intent === 'cause') {
    const regional = items
      .filter((i) => i.category === 'hotspot' && i.fire)
      .sort((a, b) => (b.fire?.hotspotCount ?? 0) - (a.fire?.hotspotCount ?? 0))
      .slice(0, 4);
    if (regional.length > 0) {
      paragraphs.push(
        `Recent satellite fire detections in the watched region: ${regional
          .map(
            (i) =>
              `${i.fire?.hotspotCount} near ${i.headline.split(' of ')[1]?.replace(/ in 24 h$/, '') ?? i.locationId} ${cite(i, citations)}`,
          )
          .join('; ')}.`,
      );
    } else {
      paragraphs.push(
        'No fire hotspots are on record for the watched region in the last 24 hours.',
      );
    }
    paragraphs.push(
      'Hotspots show where satellites saw heat, not where the haze over a city came from. Attributing smoke to fires needs a transport model and review, which HazeWatch does not do yet.',
    );
  } else if (intent === 'sources') {
    const here = items.filter((i) => i.locationId === first.id);
    const kinds = new Map<string, HazeItem>();
    for (const item of here)
      if (!kinds.has(item.tags[1] ?? '')) kinds.set(item.tags[1] ?? '', item);
    paragraphs.push(
      here.length > 0
        ? `For ${first.name} I have ${here.length} record(s): ${[
            ...kinds.values(),
          ]
            .map(
              (i) =>
                `${i.tags[1]} data, newest ${i.observedAt} ${cite(i, citations)}`,
            )
            .join('; ')}.`
        : `I have no records for ${first.name} yet.`,
      'Every record keeps its evidence: the exact bytes retrieved (hashed), when, from where, and its limitations. Open a record to see them.',
    );
  } else {
    paragraphs.push(
      ...placeSummary(
        first,
        items,
        input.nearby.get(first.id) ?? [],
        citations,
      ),
    );
  }

  if (input.refreshNote) paragraphs.push(input.refreshNote);
  const recalled = input.recalled.filter((r) => r.relevance >= 0.4);
  if (recalled[0]) {
    paragraphs.push(
      `H-Mem recalled a similar earlier question (${recalled[0].at.slice(0, 16).replace('T', ' ')} UTC): "${recalled[0].content.split('\n')[0]?.slice(3, 140)}".`,
    );
  }
  paragraphs.push(
    'Information only. Values are checked by HazeOps for integrity and coverage but not independently verified, and this answer was filled in from a template, not written by an AI model.',
  );

  const summary = paragraphs
    .filter((p) => !p.startsWith('Information only'))
    .join(' ')
    .slice(0, 400);
  return { paragraphs, citations, summary };
}
