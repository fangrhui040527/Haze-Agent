import type { Citation } from '../../../frontend/src/shared/types/agents.ts';
import type {
  HazeItem,
  Location,
} from '../../../frontend/src/shared/types/domain.ts';
import type {
  TaskBlock,
  TaskKind,
  TaskResult,
} from '../../../frontend/src/shared/types/tasks.ts';
import type { Framing } from '../manager/manager.ts';
import {
  NEARBY_SENSOR_KM,
  pm25,
  round1,
  STATUS_WORDS,
  type NearbyReading,
} from '../runs/answer.ts';

/**
 * Task reports built only from projected World Model items, by fixed templates. No AI
 * model writes these sentences and nothing is computed that a worker did not produce:
 * WorkerShield (planning, damage accounting) is not connected, so a report gives the
 * evidence on record, says plainly what was not done and lists what is needed next.
 * This is the truthful partial output of v0.14 §9.
 */

export type ComposedTask = Omit<TaskResult, 'taskId' | 'state'>;

/** A block before it gets its id (Omit spread over each block type). */
type DraftBlock = TaskBlock extends infer B
  ? B extends TaskBlock
    ? Omit<B, 'id'>
    : never
  : never;

export function taskTitle(kind: TaskKind, framing: Framing): string {
  const placeName = framing.places[0]?.name ?? 'the requested place';
  return kind === 'scheduling'
    ? `Outdoor work schedule: ${placeName}`
    : `Revenue recovery after haze: ${placeName}`;
}

const time = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function conditionsTable(
  place: Location,
  items: HazeItem[],
  nearby: NearbyReading[],
  citations: Citation[],
): { block: Omit<TaskBlock & { type: 'table' }, 'id'>; found: number } {
  const cite = (item: HazeItem) => {
    if (!citations.some((c) => c.itemId === item.id))
      citations.push({ label: item.headline, itemId: item.id });
    return `[${citations.findIndex((c) => c.itemId === item.id) + 1}]`;
  };
  const here = items.filter((i) => i.locationId === place.id);
  const sensor = nearby
    .filter((n) => n.item.status !== 'stale')
    .sort((a, b) => a.km - b.km)[0];
  const modeled = here.find((i) => i.id === `hz-modeled-${place.id}`);
  const forecast = here.find((i) => i.id === `hz-forecast-${place.id}`);
  const hotspots = here.find((i) => i.id === `hz-hotspots-${place.id}`);
  const rows: string[][] = [];
  if (sensor)
    rows.push([
      `Nearest sensor (${sensor.stationName}, ${sensor.km.toFixed(1)} km)`,
      `PM2.5 ${round1(pm25(sensor.item))}`,
      STATUS_WORDS[sensor.item.status],
      `${time(sensor.item.observedAt)} ${cite(sensor.item)}`,
    ]);
  if (modeled)
    rows.push([
      'CAMS model, ~45 km cell',
      `PM2.5 ${round1(pm25(modeled))}`,
      STATUS_WORDS[modeled.status],
      `${time(modeled.observedAt)} ${cite(modeled)}`,
    ]);
  if (forecast?.forecast)
    rows.push([
      'Model forecast, next 24 h',
      `${forecast.forecast.direction}, peak near ${round1(forecast.forecast.expectedPm25)}`,
      STATUS_WORDS[forecast.status],
      `${time(forecast.observedAt)} ${cite(forecast)}`,
    ]);
  if (hotspots?.fire)
    rows.push([
      'Satellite fire hotspots, 150 km, 24 h',
      String(hotspots.fire.hotspotCount),
      STATUS_WORDS[hotspots.status],
      `${time(hotspots.observedAt)} ${cite(hotspots)}`,
    ]);
  if (rows.length === 0)
    rows.push([
      'No records',
      'no value',
      '—',
      `Nothing on record for ${place.name} yet`,
    ]);
  return {
    block: {
      type: 'table',
      columns: ['Evidence', 'Value', 'Status', 'Observed'],
      rows,
    },
    found: sensor || modeled || forecast || hotspots ? rows.length : 0,
  };
}

export function composeTask(input: {
  kind: TaskKind;
  framing: Framing;
  items: HazeItem[];
  nearby: Map<string, NearbyReading[]>;
  refreshNote: string | null;
}): ComposedTask {
  const { kind, framing, items } = input;
  const citations: Citation[] = [];
  const blocks: DraftBlock[] = [];
  const place = framing.places[0];
  const placeName = place?.name ?? 'the requested place';
  const title = taskTitle(kind, framing);

  blocks.push({ type: 'heading', text: title });
  blocks.push({ type: 'quote', text: framing.objective.text });
  if (framing.defaulted && place)
    blocks.push({
      type: 'callout',
      tone: 'info',
      text: `You did not name a place I recognise, so this report is for ${place.name}.`,
    });

  let found = 0;
  blocks.push({ type: 'heading', text: 'Haze conditions on record' });
  if (place) {
    const table = conditionsTable(
      place,
      items,
      input.nearby.get(place.id) ?? [],
      citations,
    );
    found = table.found;
    blocks.push(table.block);
  } else {
    blocks.push({
      type: 'paragraph',
      text: 'No configured location matched, so no records were read.',
    });
  }
  if (input.refreshNote)
    blocks.push({ type: 'paragraph', text: input.refreshNote });

  const gaps: string[] = [
    'Not independently checked: EvidenceCritic is not connected.',
  ];
  let nextRequirements: string[];
  let assumptions: string[];

  if (kind === 'scheduling') {
    blocks.push({ type: 'heading', text: 'Schedule' });
    blocks.push({
      type: 'callout',
      tone: 'warning',
      text: 'No schedule was computed. Planning work around haze belongs to WorkerShield, which is not connected yet. HazeWatch does not give health or safety advice; follow official guidance such as the Department of Environment and Ministry of Health advisories.',
    });
    nextRequirements = [
      'Crew size and roles, and where each task happens',
      'Shift windows that can move, and ones that cannot',
      'The official limits or advisories your organisation follows',
      'WorkerShield connected, to build and check a schedule',
    ];
    blocks.push({ type: 'heading', text: 'What a schedule needs from you' });
    blocks.push({ type: 'bullets', items: nextRequirements.slice(0, 3) });
    gaps.push(
      'No crew, roster or task data was provided.',
      'Only a 24-hour forecast peak is on record, not an hourly forecast.',
      'No reviewed method links PM2.5 readings to safe working hours.',
    );
    assumptions = [
      'The work happens at or near the named place.',
      `Sensor readings are taken from within ${NEARBY_SENSOR_KM} km of it.`,
    ];
  } else {
    blocks.push({
      type: 'heading',
      text: 'What the records can and cannot say',
    });
    blocks.push({
      type: 'paragraph',
      text: 'These records describe air quality. They cannot show how much revenue the haze cost: a drop in sales during a haze episode can also come from the season, prices or other events. Haze readings alone do not prove the cause.',
    });
    blocks.push({
      type: 'heading',
      text: 'How a recovery analysis would work',
    });
    blocks.push({
      type: 'bullets',
      items: [
        'Compare daily revenue before, during and after the episode, and against the same weeks last year.',
        'Separate sales that were lost from sales that were only delayed.',
        'List haze costs (closures, cleaning, filters) apart from lost revenue, and count nothing twice.',
        'Check whether a relief programme or insurance applies, using the official source.',
      ],
    });
    blocks.push({
      type: 'callout',
      tone: 'warning',
      text: 'No damage figure or recovery plan was computed. Damage accounting and planning belong to WorkerShield, which is not connected yet.',
    });
    nextRequirements = [
      'Business type and location',
      'Daily or weekly revenue for at least four weeks before, during and after the haze',
      'Dates you closed or cut hours, and costs the haze caused',
      'WorkerShield connected, to run the analysis',
    ];
    blocks.push({ type: 'heading', text: 'What an analysis needs from you' });
    blocks.push({ type: 'bullets', items: nextRequirements.slice(0, 3) });
    gaps.push(
      'No revenue or cost data was provided.',
      'No reviewed damage-accounting method is connected.',
    );
    assumptions = [
      'The business is at or near the named place.',
      'The haze episode in question is the current one on record.',
    ];
  }

  if (found === 0) gaps.unshift(`No haze records on file for ${placeName}.`);

  return {
    kind,
    title,
    objective: {
      text: framing.objective.text,
      revision: framing.objective.revision,
    },
    blocks: blocks.map((b, i) => ({ ...b, id: `b${i + 1}` }) as TaskBlock),
    citations,
    coverage: place
      ? `${placeName}: ${found} kind(s) of record from the World Model, sensors within ${NEARBY_SENSOR_KM} km.`
      : 'No place matched.',
    gaps,
    assumptions,
    uncertainty: [
      'Model estimates and forecasts are regional and not checked against sensors.',
    ],
    openQuestions: [],
    review: {
      status: 'not_reviewed',
      note: 'Filled in from a template from World Model records; not reviewed by EvidenceCritic or a qualified person.',
    },
    asOf: new Date().toISOString(),
    nextRequirements,
    provenance: {
      agents: ['manager', 'hazeops', 'worldmodel'],
      method: 'template',
      model: null,
    },
  };
}
