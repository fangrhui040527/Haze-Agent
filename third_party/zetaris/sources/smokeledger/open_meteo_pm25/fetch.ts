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

const ENDPOINT = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const SOURCE = 'Open-Meteo PM2.5';

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const locations = await readLocations(options.locationIds);
  const issuedAt = new Date();
  issuedAt.setUTCMinutes(0, 0, 0);

  const rowCount = await withDatabase(async (client) => {
    await seedTowns(client, locations, options.dryRun);
    let totalRows = 0;

    for (const batch of locationBatches(locations)) {
      const url = chunkedLocationUrl(ENDPOINT, batch, {
        hourly: 'pm2_5',
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
        const values = numericHourlySeries(response.hourly, 'pm2_5', times.length, SOURCE);
        times.forEach((validAt, hour) => {
          const value = values[hour];
          if (value !== null && value !== undefined) {
            rows.push([
              location.name,
              validAt,
              'model',
              issuedAt,
              value,
              'open-meteo-air-quality',
            ]);
          }
        });
      });

      totalRows += rows.length;
      if (!options.dryRun) {
        await insertRows(
          client,
          'pm25',
          ['town', 'valid_utc', 'kind', 'issued_utc', 'pm25', 'source'],
          rows,
          "ON CONFLICT (town, valid_utc, kind, (COALESCE(issued_utc, 'epoch'::timestamptz))) DO UPDATE SET pm25 = EXCLUDED.pm25, source = EXCLUDED.source, ingested_utc = now()",
        );
      }
    }
    return totalRows;
  });

  reportResult(SOURCE, rowCount, options.dryRun);
}

main().catch((error: unknown) => reportError(SOURCE, error));
