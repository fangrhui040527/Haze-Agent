import { bandForPm25, bandLabel } from '../../shared/lib/bands.ts';
import type { Rng } from '../../shared/lib/random.ts';
import type {
  CategoryId,
  HazeItem,
  Impact,
  Trend,
} from '../../shared/types/domain.ts';
import type { LocationSeed } from './locations.ts';

/** Facts the text templates can use. */
export interface TextFacts {
  seed: LocationSeed;
  category: CategoryId;
  pm25: number | null;
  pm10: number | null;
  trend: Trend | null;
  fire: HazeItem['fire'];
  forecast: HazeItem['forecast'];
  impacts: Impact[];
  weather: HazeItem['weather'];
  stationCode: string;
  district: string;
  sourceCount: number;
}

const value = (n: number | null, unit = ' µg/m³') =>
  n === null ? 'no data' : `${n}${unit}`;
const bandText = (pm25: number | null) =>
  pm25 === null ? 'band unknown' : bandLabel(bandForPm25(pm25));
const trendWord = (trend: Trend | null) =>
  trend === 'up' ? 'rises to' : trend === 'down' ? 'falls to' : 'steady at';

export function headlineFor(f: TextFacts, rng: Rng): string {
  const name = f.seed.location.name;
  switch (f.category) {
    case 'reading':
      return f.pm25 === null
        ? `No PM2.5 data from ${name} monitors`
        : `PM2.5 ${trendWord(f.trend)} ${f.pm25} µg/m³ in ${name}`;
    case 'hotspot':
      return `${f.fire?.hotspotCount ?? 'Several'} fire hotspots detected near ${name}`;
    case 'forecast': {
      const hours = f.forecast
        ? Math.round(
            (Date.parse(f.forecast.validTo) -
              Date.parse(f.forecast.validFrom)) /
              3_600_000,
          )
        : 24;
      const verb =
        f.forecast?.direction === 'worsening'
          ? 'worsen'
          : f.forecast?.direction === 'improving'
            ? 'ease'
            : 'stay similar';
      return `Haze expected to ${verb} in ${name} over the next ${hours} hours`;
    }
    case 'advisory':
      return rng.pick([
        `Air-quality advisory issued for ${name}`,
        `Authorities raise haze alert level for ${name}`,
        `${name} authorities urge reduced outdoor activity`,
      ]);
    case 'health':
      return `Health guidance updated for ${name}`;
    case 'disruption':
      return disruptionHeadline(f, name);
    case 'news':
      return rng.pick([
        `Local media report thick haze over ${name}`,
        `Haze returns to ${name}, residents told to stay alert`,
        `Visibility drops across ${name} as smoke lingers`,
      ]);
    case 'community':
      return `Residents report smoke smell in ${f.district}, ${name}`;
    case 'sensor_issue':
      return `Monitor ${f.stationCode} in ${name} offline`;
  }
}

function disruptionHeadline(f: TextFacts, name: string): string {
  const impact = f.impacts[0];
  if (!impact) return `Haze disrupts daily life in ${name}`;
  switch (impact.kind) {
    case 'school_closure':
      return `${impact.count ?? 'Some'} schools closed in ${name} due to haze`;
    case 'flight_delay': {
      const visibility = f.weather?.visibilityKm ?? null;
      // Only quote visibility when it is actually low; "drops to 23 km" would contradict a delay.
      return visibility !== null && visibility <= 5
        ? `Flights delayed at ${name} airport as visibility drops to ${visibility} km`
        : `Flights delayed at ${name} airport due to haze`;
    }
    case 'event_cancelled':
      return `Outdoor events cancelled in ${name}`;
    case 'transport':
      return `Ferry and road services slowed by haze around ${name}`;
    case 'hospital_visits':
      return `Clinics in ${name} report more respiratory visits`;
    case 'outdoor_work_advisory':
      return `Outdoor-work advisory issued in ${name}`;
  }
}

export function summaryFor(f: TextFacts): string {
  switch (f.category) {
    case 'reading':
      return f.pm25 === null
        ? 'Stations reported no PM2.5 value for this hour.'
        : `${bandText(f.pm25)} · PM10 ${value(f.pm10)} · wind ${f.weather?.windDirection ?? '?'} ${value(f.weather?.windSpeedKmh ?? null, ' km/h')}`;
    case 'hotspot':
      return `${f.fire?.hotspotCount ?? '?'} hotspots on ${f.fire?.landType ?? 'unknown'} land, ${f.fire?.detectionConfidence ?? '?'} confidence.`;
    case 'forecast':
      return `Model expects PM2.5 near ${value(f.forecast?.expectedPm25 ?? null)} (${f.forecast?.direction ?? 'unknown'}).`;
    case 'advisory':
      return `Official advisory; current band: ${bandText(f.pm25)}.`;
    case 'health':
      return 'Official guidance notice (demo text). Not medical advice.';
    case 'disruption':
      return (
        f.impacts.map((i) => i.description).join(' ') ||
        'Daily activities affected.'
      );
    case 'news':
      return f.pm25 === null
        ? 'Media report without a measured value.'
        : `Media report quoting PM2.5 ${f.pm25} µg/m³ (not independently measured).`;
    case 'community':
      return `Unverified reports from residents in ${f.district}.`;
    case 'sensor_issue':
      return `Station ${f.stationCode} stopped reporting; nearby coverage reduced.`;
  }
}

export function detailsFor(f: TextFacts, rng: Rng): string[] {
  const { location, profile } = f.seed;
  const paragraphs: string[] = [];
  switch (f.category) {
    case 'reading':
      paragraphs.push(
        f.pm25 === null
          ? `Monitoring stations in ${location.name} did not report a PM2.5 value for the latest hour. Missing data is shown as "no data", never as zero.`
          : `The latest 1-hour PM2.5 reading in ${location.name} is ${f.pm25} µg/m³, in the "${bandText(f.pm25)}" demo band. PM10 is ${value(f.pm10)}.`,
      );
      if (f.weather) {
        paragraphs.push(
          `Winds are from the ${f.weather.windDirection ?? 'unknown direction'} at ${value(f.weather.windSpeedKmh, ' km/h')}; humidity ${value(f.weather.humidityPct, '%')}; visibility ${value(f.weather.visibilityKm, ' km')}.`,
        );
      }
      break;
    case 'hotspot':
      paragraphs.push(
        `Satellites detected ${f.fire?.hotspotCount ?? 'several'} heat anomalies within about 50 km of ${location.name}, mostly on ${f.fire?.landType ?? 'mixed'} land. The strongest had a fire radiative power of ${value(f.fire?.maxFrpMw ?? null, ' MW')}.`,
        'A hotspot is a heat signal seen from space. It is not a confirmed fire, and clouds or thick smoke can hide fires completely.',
      );
      break;
    case 'forecast':
      paragraphs.push(
        `The forecast model expects PM2.5 around ${value(f.forecast?.expectedPm25 ?? null)} in ${location.name}, ${f.forecast?.direction ?? 'with no clear direction'}.`,
        'Forecasts are model estimates on a coarse grid. They are not measurements and can be wrong for a specific street or hour.',
      );
      break;
    case 'advisory':
      paragraphs.push(
        `Local authorities issued an air-quality advisory for ${location.name}. The current demo band is "${bandText(f.pm25)}".`,
        'In a real deployment this text would quote the official advisory word for word, with a link.',
      );
      break;
    case 'health':
      paragraphs.push(
        `Health guidance for ${location.name} was updated (fictional notice).`,
        'This is demo text. Real guidance must come from the local health authority; Haze does not give medical advice.',
      );
      break;
    case 'disruption':
      paragraphs.push(
        ...f.impacts.map(
          (i) =>
            `${i.description}${i.count !== null ? ` (count: ${i.count})` : ''}`,
        ),
      );
      break;
    case 'news':
      paragraphs.push(
        `A media report describes haze over ${location.name}.${f.pm25 !== null ? ` It quotes PM2.5 of ${f.pm25} µg/m³, which has not been independently measured.` : ''}`,
        'News reports are treated as leads, not measurements, until EvidenceCritic finds matching observations.',
      );
      break;
    case 'community':
      paragraphs.push(
        `${rng.int(3, 40)} residents in ${f.district} reported a smoke smell or haze through a community app.`,
        'Community reports are unverified but can be an early warning.',
      );
      break;
    case 'sensor_issue':
      paragraphs.push(
        `Monitoring station ${f.stationCode} in ${location.name} has stopped reporting. Readings from this area may be missing or older than usual.`,
        'A missing station never means clean air: "no data" is not "all clear".',
      );
      break;
  }
  paragraphs.push(
    `Typical haze driver here (demo profile): ${profile.driver}. Based on ${f.sourceCount} source(s).`,
  );
  return paragraphs;
}

export const LONG_TEXT =
  'This deliberately long text tests how the interface handles very long content. ' +
  'It repeats several clauses so that table cells must truncate it with an ellipsis, the detail page must wrap it across many lines, ' +
  'and nothing should overflow its container or create a horizontal scrollbar on the page. '.repeat(
    4,
  );
