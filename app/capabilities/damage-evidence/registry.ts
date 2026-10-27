import type { EvidenceSourceDefinition } from './contracts.js';

const catalogue = 'https://api.data.gov.my/data-catalogue/';
const base = {
  access_requirements: [] as string[],
  refresh_cadence_seconds: 86_400,
  minimum_request_interval_ms: 15_100,
  maximum_bytes: 8 * 1024 * 1024,
};

/** Operational definitions describe acquisition, never scientific acceptance. */
export const DAMAGE_EVIDENCE_SOURCES: readonly EvidenceSourceDefinition[] = [
  {
    ...base,
    id: 'dosm-district-population',
    kind: 'numerical',
    title: 'DOSM annual administrative district population',
    supported_inputs: ['population'],
    endpoint: 'https://storage.dosm.gov.my/population/population_district.csv',
    documentation_url:
      'https://open.dosm.gov.my/data-catalogue/population_district',
    geography:
      'Malaysian administrative district, state; source boundary version unspecified',
    period: { start: '2020-01-01', end: null, resolution: 'annual' },
    units: ['thousand_persons'],
    parser_version: 'dosm-population-csv.v1',
    refresh_cadence_seconds: 604_800,
    maximum_bytes: 64 * 1024 * 1024,
    limitations: [
      'District totals are not population grids.',
      'The source population unit is thousands of persons; normalization multiplies by 1000.',
      'A catalogue API filter failed during research; the CSV is the registered route.',
    ],
    discovery_queries: {
      en: 'site:open.dosm.gov.my population district Malaysia methodology',
      ms: 'site:open.dosm.gov.my penduduk daerah metodologi',
    },
  },
  {
    ...base,
    id: 'dosm-district-deaths',
    kind: 'numerical',
    title: 'DOSM annual all-cause district deaths',
    supported_inputs: ['mortality_baseline'],
    endpoint: `${catalogue}?id=deaths_district_sex`,
    documentation_url: 'https://data.gov.my/data-catalogue/deaths_district_sex',
    geography:
      'Malaysian administrative district, state; source boundary version unspecified',
    period: { start: null, end: null, resolution: 'annual' },
    units: ['deaths'],
    parser_version: 'dosm-deaths-json.v1',
    limitations: [
      'All-cause annual counts do not establish haze-attributable deaths.',
      'No daily, age-specific or cause-specific response is inferred.',
    ],
    discovery_queries: {
      en: 'site:data.gov.my deaths district sex methodology',
      ms: 'site:data.gov.my kematian daerah jantina metodologi',
    },
  },
  {
    ...base,
    id: 'dosm-selangor-wages',
    kind: 'numerical',
    title: 'DOSM annual state wages',
    supported_inputs: ['wage_context'],
    endpoint: `${catalogue}?id=wages_state`,
    documentation_url: 'https://open.dosm.gov.my/data-catalogue/wages_state',
    geography: 'Malaysian state; citizen employee coverage must be reviewed',
    period: {
      start: null,
      end: null,
      resolution: 'annual observations of monthly wages',
    },
    units: ['MYR/month'],
    parser_version: 'dosm-wages-json.v1',
    limitations: [
      'Monthly wages are not lost workdays or an automatically applicable daily loss.',
      'State and employee coverage cannot be silently assigned to district residents.',
    ],
    discovery_queries: {
      en: 'site:open.dosm.gov.my wages state methodology citizens',
      ms: 'site:open.dosm.gov.my gaji upah negeri metodologi',
    },
  },
  {
    ...base,
    id: 'malaysia-monthly-pollution',
    kind: 'numerical',
    title: 'Malaysia monthly ambient PM2.5 context',
    supported_inputs: ['ambient_pm25'],
    endpoint: `${catalogue}?id=air_pollution`,
    documentation_url: 'https://data.gov.my/data-catalogue/air_pollution',
    geography: 'Malaysia national aggregate; no district or station field',
    period: { start: null, end: null, resolution: 'monthly' },
    units: ['ug/m3'],
    parser_version: 'malaysia-pollution-json.v1',
    limitations: [
      'National monthly context is not district episode exposure or a fire counterfactual.',
      'PM10 and Air Pollutant Index are rejected as PM2.5 concentration.',
    ],
    discovery_queries: {
      en: 'site:data.gov.my air_pollution PM2.5 units methodology',
      ms: 'site:data.gov.my pencemaran udara PM2.5 kepekatan',
    },
  },
  {
    ...base,
    id: 'open-meteo-air-quality',
    kind: 'numerical',
    title: 'Open-Meteo CAMS modeled ambient PM2.5',
    supported_inputs: ['ambient_pm25'],
    endpoint: 'https://air-quality-api.open-meteo.com/v1/air-quality',
    documentation_url: 'https://open-meteo.com/en/docs/air-quality-api',
    geography:
      'Returned CAMS model grid cell, not an administrative district or station',
    period: { start: '2022-08-01', end: null, resolution: 'hourly' },
    units: ['ug/m3'],
    parser_version: 'open-meteo-air-json.v1',
    minimum_request_interval_ms: 1000,
    refresh_cadence_seconds: 21_600,
    access_requirements: [
      'Service terms and attribution; permitted noncommercial free usage.',
    ],
    limitations: [
      'Modeled ambient concentrations are not observed station values or selected-fire-removed exposure.',
      'Archive availability does not establish scientific suitability.',
    ],
    discovery_queries: {
      en: 'site:open-meteo.com/en/docs/air-quality-api CAMS global historical pm2_5',
      ms: 'Malaysia jerebu PM2.5 CAMS pemodelan udara',
    },
  },
  ...(
    [
      [
        'crippa-2016-acute-mortality-pmc',
        'Crippa et al. 2016 original article in PubMed Central',
        'https://pmc.ncbi.nlm.nih.gov/articles/PMC5111049/',
        [
          'episode_definition',
          'published_physical_effect',
          'physical_effect_method',
        ],
        'Public full-text repository fallback for DOI 10.1038/srep37074; country-specific and acute/long-term applicability still require review.',
      ],
      [
        'koplitz-2016-fire-mortality',
        'Koplitz et al. 2016 modeled 2006/2015 fire mortality',
        'https://projects.iq.harvard.edu/files/acmg/files/koplitz_fires_2016.pdf',
        [
          'episode_definition',
          'published_physical_effect',
          'physical_effect_method',
        ],
        'Published modeled mortality estimates require endpoint/duration/geography review; the paper is not a Malaysian official death register.',
      ],
      [
        'crippa-2016-acute-mortality',
        'Crippa et al. 2016 acute 2015 fire mortality',
        'https://www.nature.com/articles/srep37074',
        [
          'episode_definition',
          'published_physical_effect',
          'physical_effect_method',
        ],
        'Acute September-October estimates and long-term risk extrapolations are distinct; regional totals cannot be assigned to Malaysia alone.',
      ],
      [
        'asmc-episode-evidence',
        'ASMC episode and smoke context',
        'https://asmc.asean.org/asmc-alerts/',
        ['episode_definition'],
        'Public regional products; PM10 maps do not establish PM2.5 exposure.',
      ],
      [
        'who-health-response-methods',
        'WHO AirQ health response guidance',
        'https://www.who.int/tools/airq',
        ['physical_effect_method'],
        'Endpoint, duration, lag, uncertainty and Malaysian applicability need independent scientific review.',
      ],
      [
        'oecd-mortality-valuation',
        'OECD mortality risk valuation guidance',
        'https://www.oecd.org/en/publications/mortality-risk-valuation-in-policy-assessment_76ca89a2-en.html',
        ['welfare_unit_value'],
        'No Malaysian transferred value is approved; currency and price-year compatibility remain required.',
      ],
      [
        'moh-patient-fees',
        'MOH patient financial charges',
        'https://www.moh.gov.my/en/core/health-information/service-rates/caj-pesakit-luar',
        ['financial_unit_value'],
        'Patient charges do not establish full treatment resource costs.',
      ],
      [
        'doe-klang-intervention-evidence',
        'DOE open-burning programme lead',
        'https://www.doe.gov.my/en/open-burning/',
        [
          'intervention_mechanism',
          'intervention_cost',
          'intervention_effectiveness',
        ],
        'Policy or enforcement activity does not establish incremental intervention cost or causal effectiveness.',
      ],
      [
        'moh-health-baseline',
        'MOH health facts',
        'https://www.moh.gov.my/en/publications-and-reports/infographics-reports-statistics/health-facts/list-of-health-facts',
        ['morbidity_baseline'],
        'Detailed diagnosis and event-day data may require MyHDW permission.',
      ],
      [
        'doe-apims',
        'DOE APIMS',
        'https://eqms.doe.gov.my/apims/main',
        ['pollution_source_lead'],
        'Air Pollutant Index is not a PM2.5 concentration; no historical numerical route is registered.',
      ],
      [
        'worldpop-population-grid',
        'WorldPop Malaysia population grids',
        'https://hub.worldpop.org/rest/data/pop',
        ['population_grid'],
        'A specific raster release, strata, year and grid alignment still need acquisition and review.',
      ],
      [
        'dosm-district-boundary',
        'DOSM district boundary lead',
        'https://github.com/dosm-malaysia/data-open/tree/main/datasets/geodata',
        ['administrative_geometry'],
        'Pin original geometry commit and boundary meaning/year before analysis.',
      ],
      [
        'dosm-cpi',
        'DOSM consumer price index',
        'https://open.dosm.gov.my/data-catalogue/cpi_state',
        ['price_year_conversion'],
        'No deflator selection or numerical adapter approved.',
      ],
      [
        'bnm-exchange-rates',
        'BNM exchange rates',
        'https://data.gov.my/data-catalogue/exchangerates_daily_1700',
        ['currency_conversion'],
        'No buying/selling/middle rate or date is selected.',
      ],
    ] as const
  ).map(
    ([
      id,
      title,
      endpoint,
      supported,
      limitation,
    ]): EvidenceSourceDefinition => ({
      ...base,
      id,
      title,
      endpoint,
      documentation_url: endpoint,
      kind: 'document',
      supported_inputs: [...supported],
      geography: 'See retained source; no scientific applicability inferred',
      period: {
        start: null,
        end: null,
        resolution: 'document publication, distinct from observations',
      },
      units: [],
      parser_version: 'public-document-text.v2',
      refresh_cadence_seconds: 604_800,
      limitations: [limitation],
      discovery_queries: {
        en: `site:${new URL(endpoint).hostname} Malaysia ${title}`,
        ms: `site:${new URL(endpoint).hostname} Malaysia jerebu bukti kajian`,
      },
    }),
  ),
  ...(
    [
      [
        'nasa-firms',
        'https://firms.modaps.eosdis.nasa.gov/api/area/',
        ['fire_detections'],
        'NASA FIRMS MAP_KEY required; use the existing registered evidence collector.',
      ],
      [
        'cams-gfas',
        'https://ads.atmosphere.copernicus.eu/datasets/cams-global-fire-emissions-gfas?tab=overview',
        ['fire_emissions'],
        'Copernicus ADS token and accepted dataset terms required; transport method remains separate.',
      ],
      [
        'era5-single-levels',
        'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels?tab=overview',
        ['meteorology'],
        'Copernicus CDS token and accepted terms required.',
      ],
      [
        'cams-eac4',
        'https://ads.atmosphere.copernicus.eu/datasets/cams-global-reanalysis-eac4?tab=overview',
        ['historical_pm25_grid'],
        'Copernicus ADS token and terms required; kg/m3 conversion and grid suitability must be reviewed.',
      ],
      [
        'cams-global-forecast',
        'https://ads.atmosphere.copernicus.eu/datasets/cams-global-atmospheric-composition-forecasts?tab=overview',
        ['recent_pm25_grid'],
        'Copernicus ADS token and terms required; forecast version changes must be reviewed.',
      ],
    ] as const
  ).map(([id, endpoint, supported, access]): EvidenceSourceDefinition => ({
    ...base,
    id,
    title: id,
    endpoint,
    documentation_url: endpoint,
    kind: 'access_gap',
    supported_inputs: [...supported],
    geography: 'Provider domain; selected grid not acquired',
    period: { start: null, end: null, resolution: 'unselected' },
    units: [],
    parser_version: 'unimplemented',
    access_requirements: [access],
    limitations: [access],
    discovery_queries: {
      en: `site:${new URL(endpoint).hostname} ${id} Malaysia`,
      ms: `Malaysia jerebu ${id}`,
    },
  })),
];

export function damageEvidenceSource(id: string): EvidenceSourceDefinition {
  const source = DAMAGE_EVIDENCE_SOURCES.find((entry) => entry.id === id);
  if (!source) throw new Error(`Unregistered damage evidence source: ${id}`);
  return source;
}
