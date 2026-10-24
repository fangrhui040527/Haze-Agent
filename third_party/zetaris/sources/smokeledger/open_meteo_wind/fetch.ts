import {
  chunkedLocationUrl,
  fetchJson,
  hourlyTimes,
  insertRows,
  locationBatches,
  normalizeOpenMeteoResponse,
  numericHourlySeries,
  parseCliOptions,
  readLocations,
  reportError,
  reportResult,
  seedTowns,
  withDatabase,
  type SqlValue,
} from '../common.ts';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const SOURCE = 'Open-Meteo wind';
const DEG_TO_RAD = Math.PI / 180;

function windComponent(speed: number, direction: number, axis: 'u' | 'v'): number {
  const radians = direction * DEG_TO_RAD;
  return axis === 'u'
    ? -speed * Math.sin(radians)
    : -speed * Math.cos(radians);
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const locations = await readLocations(options.locationIds);

  const rowCount = await withDatabase(async (client) => {
    await seedTowns(client, locations, options.dryRun);
    let totalRows = 0;

    for (const batch of locationBatches(locations)) {
      const url = chunkedLocationUrl(ENDPOINT, batch, {
        hourly:
          'wind_speed_10m,wind_direction_10m,wind_speed_850hPa,wind_direction_850hPa',
        wind_speed_unit: 'ms',
        past_days: '1',
        forecast_days: '3',
        timezone: 'GMT',
      });
      const payload = await fetchJson(SOURCE, url);
      const responses = normalizeOpenMeteoResponse(payload, batch.length, SOURCE);
      const rows: SqlValue[][] = [];

      responses.forEach((response, index) => {
        const location = batch[index];
        if (location === undefined) {
          throw new Error(`${SOURCE} response location ordering is invalid.`);
        }
        const times = hourlyTimes(response.hourly, SOURCE);
        const series = [
          {
            level: '10m',
            speed: numericHourlySeries(
              response.hourly,
              'wind_speed_10m',
              times.length,
              SOURCE,
            ),
            direction: numericHourlySeries(
              response.hourly,
              'wind_direction_10m',
              times.length,
              SOURCE,
            ),
          },
          {
            level: '850hPa',
            speed: numericHourlySeries(
              response.hourly,
              'wind_speed_850hPa',
              times.length,
              SOURCE,
            ),
            direction: numericHourlySeries(
              response.hourly,
              'wind_direction_850hPa',
              times.length,
              SOURCE,
            ),
          },
        ];

        for (const level of series) {
          times.forEach((validAt, hour) => {
            const speed = level.speed[hour];
            const direction = level.direction[hour];
            if (
              speed !== null &&
              speed !== undefined &&
              direction !== null &&
              direction !== undefined
            ) {
              rows.push([
                level.level,
                location.latitude,
                location.longitude,
                validAt,
                windComponent(speed, direction, 'u'),
                windComponent(speed, direction, 'v'),
              ]);
            }
          });
        }
      });

      totalRows += rows.length;
      if (!options.dryRun) {
        await insertRows(
          client,
          'wind',
          ['level', 'lat', 'lon', 'valid_utc', 'u', 'v'],
          rows,
          'ON CONFLICT (level, lat, lon, valid_utc) DO UPDATE SET u = EXCLUDED.u, v = EXCLUDED.v',
        );
      }
    }
    return totalRows;
  });

  reportResult(SOURCE, rowCount, options.dryRun);
}

main().catch((error: unknown) => reportError(SOURCE, error));
