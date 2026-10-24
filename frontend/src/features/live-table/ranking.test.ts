import { describe, expect, it } from 'vitest';
import type {
  EvidenceCheck,
  HazeItem,
  Location,
} from '../../shared/types/domain.ts';
import { rankItem, rankItems, RANKING } from './ranking.ts';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const check = (result: EvidenceCheck['result']): EvidenceCheck => ({
  id: result,
  label: result,
  result,
  detail: '',
});

function item(overrides: Partial<HazeItem> = {}): HazeItem {
  return {
    id: 'a',
    fictional: true,
    locationId: 'x',
    category: 'reading',
    headline: 'h',
    summary: 's',
    details: [],
    status: 'verified',
    observedAt: hoursAgo(0),
    updatedAt: hoursAgo(0),
    revision: 1,
    measurements: [
      { pollutant: 'pm25', value: 60, unit: 'µg/m³', averaging: '1h' },
    ],
    trend: null,
    weather: null,
    fire: null,
    forecast: null,
    impacts: [],
    sources: [],
    checks: [check('pass'), check('pass')],
    agentResults: [],
    timeline: [],
    relatedIds: [],
    tags: [],
    ...overrides,
  };
}

describe('rankItem', () => {
  it('gives full recency to a brand-new item and halves it every 6 hours', () => {
    const fresh = rankItem(item(), NOW).parts.find((p) => p.key === 'recency');
    const sixHours = rankItem(item({ updatedAt: hoursAgo(6) }), NOW).parts.find(
      (p) => p.key === 'recency',
    );
    expect(fresh?.points).toBe(RANKING.recencyMax);
    expect(sixHours?.points).toBe(RANKING.recencyMax / 2);
  });

  it('scores severity from the PM2.5 band (60 µg/m³ is "Unhealthy" = band 3 → 24 points)', () => {
    expect(
      rankItem(item(), NOW).parts.find((p) => p.key === 'severity')?.points,
    ).toBe(24);
  });

  it('gives neutral severity when there is no PM2.5 value, never treating it as clean air', () => {
    const noData = item({
      measurements: [
        { pollutant: 'pm25', value: null, unit: 'µg/m³', averaging: '1h' },
      ],
    });
    expect(
      rankItem(noData, NOW).parts.find((p) => p.key === 'severity')?.points,
    ).toBe(RANKING.severityUnknown);
  });

  it('counts warnings as half a pass and gives 0 evidence points without checks', () => {
    const mixed = item({
      checks: [check('pass'), check('warn'), check('fail'), check('pending')],
    });
    expect(
      rankItem(mixed, NOW).parts.find((p) => p.key === 'evidence')?.points,
    ).toBe(7.5);
    expect(
      rankItem(item({ checks: [] }), NOW).parts.find(
        (p) => p.key === 'evidence',
      )?.points,
    ).toBe(0);
  });

  it('applies penalties for stale, conflicting and unverified items', () => {
    const base = rankItem(item(), NOW).score;
    expect(rankItem(item({ status: 'stale' }), NOW).score).toBe(base - 10);
    expect(rankItem(item({ status: 'conflicting' }), NOW).score).toBe(base - 5);
    expect(rankItem(item({ status: 'unverified' }), NOW).score).toBe(base - 5);
  });

  it('always scores retracted items 0', () => {
    expect(rankItem(item({ status: 'retracted' }), NOW).score).toBe(0);
  });

  it('keeps the score between 0 and 100', () => {
    const extreme = item({
      measurements: [
        { pollutant: 'pm25', value: 900, unit: 'µg/m³', averaging: '1h' },
      ],
    });
    expect(rankItem(extreme, NOW).score).toBeLessThanOrEqual(100);
    expect(
      rankItem(
        item({
          updatedAt: hoursAgo(500),
          checks: [],
          status: 'stale',
          measurements: [],
        }),
        NOW,
      ).score,
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('rankItems', () => {
  const locations: Location[] = [
    {
      id: 'x',
      name: 'Beta',
      region: 'r',
      country: 'c',
      countryCode: 'CC',
      lat: 0,
      lon: 0,
      timeZone: 'UTC',
      aqiStandard: 's',
      populationBand: 'small',
    },
    {
      id: 'y',
      name: 'Alpha',
      region: 'r',
      country: 'c',
      countryCode: 'CC',
      lat: 0,
      lon: 0,
      timeZone: 'UTC',
      aqiStandard: 's',
      populationBand: 'small',
    },
  ];

  it('sorts by score, then newest, then location name, and numbers ranks from 1', () => {
    const ranked = rankItems(
      [
        item({ id: 'low', updatedAt: hoursAgo(20) }),
        item({ id: 'tie-beta', locationId: 'x' }),
        item({ id: 'tie-alpha', locationId: 'y' }),
      ],
      locations,
      NOW,
    );
    expect(ranked.map((r) => r.item.id)).toEqual([
      'tie-alpha',
      'tie-beta',
      'low',
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });
});
