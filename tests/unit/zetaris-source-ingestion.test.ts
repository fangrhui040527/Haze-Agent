import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as airQuality from '../../app/adapters/zetaris/sources/air_quality/fetch_air_quality.ts';
import * as wind from '../../app/adapters/zetaris/sources/open_meteo_wind/fetch_open_meteo_wind.ts';
import * as pm25 from '../../app/adapters/zetaris/sources/open_meteo_pm25/fetch_open_meteo_pm25.ts';

const kualaLumpur: airQuality.Location = {
  id: 'kuala-lumpur',
  name: 'Kuala Lumpur',
  latitude: 3.1412,
  longitude: 101.68653,
};

describe('Zetaris live REST source generation', () => {
  it('selects only Kuala Lumpur for air-quality test mode', async () => {
    const locations = await airQuality.readLocations();
    expect(locations).toHaveLength(345);
    expect(
      airQuality.selectLocations(locations, [], true).map(({ id }) => id),
    ).toEqual(['kuala-lumpur']);
    expect(() =>
      airQuality.selectLocations(locations, ['not-a-location'], false),
    ).toThrow('Unknown location');
    expect(() =>
      airQuality.parseCliOptions(['--test', '--location', 'kuala-lumpur']),
    ).toThrow('cannot be combined');
  });

  it('registers air-quality REST endpoints and exposes both PM2.5 and PM10', () => {
    const url = new URL(airQuality.airQualityEndpoint(kualaLumpur));
    expect(url.hostname).toBe('air-quality-api.open-meteo.com');
    expect(url.searchParams.get('hourly')).toBe('pm2_5,pm10');
    const registration = airQuality.registrationSql([kualaLumpur]);
    expect(registration).toContain(
      'CREATE LIGHTNING REST TABLE aq_kuala_lumpur',
    );
    expect(registration).toContain('REQUEST(');
    const view = airQuality.viewSql([kualaLumpur]);
    expect(view).toContain("'kuala-lumpur' AS location_id");
    expect(view).toContain('hourly.pm2_5');
    expect(view).toContain('hourly.pm10');
    expect(view).toContain('CAST(NULL AS TIMESTAMP) AS issued_utc');
    expect(view).toContain('CAST(NULL AS TIMESTAMP) AS ingested_utc');
    expect(view).not.toContain('FILESTORE');
  });

  it('selects only Kuala Lumpur in Open-Meteo wind test mode', () => {
    const options = wind.parseCliOptions(['--test']);
    expect(
      wind.selectLocations([kualaLumpur], options.locationIds, options.test),
    ).toEqual([kualaLumpur]);
    const url = new URL(wind.endpoint(kualaLumpur));
    expect(url.searchParams.get('hourly')).toContain('wind_speed_10m');
    expect(wind.registrationSql([kualaLumpur])).toContain(
      'CREATE LIGHTNING REST TABLE wind_kuala_lumpur',
    );
    expect(wind.viewSql([kualaLumpur])).toContain('AS u_ms');
  });

  it('keeps PM2.5 test mode limited to Kuala Lumpur', () => {
    const options = pm25.parseCliOptions(['--test']);
    const locations = [kualaLumpur];
    expect(
      pm25.selectLocations(locations, options.locationIds, options.test),
    ).toEqual(locations);
    expect(pm25.registrationSql(locations)).toContain(
      'CREATE LIGHTNING REST TABLE pm25_kuala_lumpur',
    );
  });

  it('declares the live Open-Meteo activation tables in the environmental USL', async () => {
    const zetarisDir = join(process.cwd(), 'app', 'adapters', 'zetaris');
    const [schema, pm25Activation, windActivation] = await Promise.all([
      readFile(join(zetarisDir, 'usl', 'env_usl', 'usl_schema.sql'), 'utf8'),
      readFile(
        join(zetarisDir, 'sources', 'open_meteo_pm25', 'sql', 'pm25_activate.sql'),
        'utf8',
      ),
      readFile(
        join(zetarisDir, 'sources', 'open_meteo_wind', 'sql', 'wind_activate.sql'),
        'utf8',
      ),
    ]);

    expect(schema).toContain('CREATE TABLE open_meteo_pm25_obs');
    expect(schema).toContain('CREATE TABLE open_meteo_wind_obs');
    expect(pm25Activation).toContain(
      'malaysia_env.malaysia_env_usl.open_meteo_pm25_obs',
    );
    expect(windActivation).toContain(
      'malaysia_env.malaysia_env_usl.open_meteo_wind_obs',
    );
    expect(schema).toContain('pm2_5_ug_m3 double');
    expect(schema).toContain('wind_speed_ms double');
    expect(schema).toContain('wind_direction_deg double');
  });

  it('uses fresh Windy FileStore table names consistently in registration and views', async () => {
    const sourceDir = join(
      process.cwd(),
      'app',
      'adapters',
      'zetaris',
      'sources',
      'windy',
    );
    const [registration, views] = await Promise.all([
      readFile(join(sourceDir, 'sql', 'windy_register.sql'), 'utf8'),
      readFile(join(sourceDir, 'sql', 'windy_view.sql'), 'utf8'),
    ]);

    expect(registration).toContain(
      'CREATE LIGHTNING FILESTORE TABLE windy_gfs_raw_v2',
    );
    expect(registration).toContain(
      'CREATE LIGHTNING FILESTORE TABLE windy_cams_raw_v2',
    );
    expect(views).toContain('FROM WINDY_FILES.windy_gfs_raw_v2');
    expect(views).toContain('FROM WINDY_FILES.windy_cams_raw_v2');
    expect(views).not.toContain('FROM WINDY_FILES.windy_gfs_raw;');
    expect(views).not.toContain('FROM WINDY_FILES.windy_cams_raw;');
  });
});
