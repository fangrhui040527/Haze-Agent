import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HazeItem } from '../../frontend/src/shared/types/domain.ts';
import { Manager } from '../src/manager/manager.ts';
import { composeAnswer } from '../src/runs/answer.ts';
import { composeTask } from '../src/tasks/compose.ts';
import { KLANG } from './helpers.ts';

const validFrom = '2026-10-25T00:00:00.000Z';
const validTo = '2026-10-26T00:00:00.000Z';
function forecastItem(status: HazeItem['status'] = 'partial'): HazeItem {
  return {
    id: `hz-forecast-${KLANG.id}`,
    fictional: false,
    locationId: KLANG.id,
    category: 'forecast',
    headline: 'Test forecast',
    summary: '',
    details: [],
    status,
    observedAt: validFrom,
    updatedAt: validFrom,
    revision: 1,
    forecast: { validFrom, validTo, expectedPm25: 25, direction: 'worsening' },
    measurements: [],
    trend: null,
    weather: null,
    fire: null,
    impacts: [],
    sources: [],
    checks: [],
    agentResults: [],
    timeline: [],
    relatedIds: [],
    tags: [],
  };
}

afterEach(() => vi.restoreAllMocks());

describe.each(['overview', 'forecast'] as const)(
  '%s forecast wording',
  (intent) => {
    const answerFor = (item: HazeItem) =>
      composeAnswer({
        question: 'Klang forecast',
        intent,
        places: [KLANG],
        defaulted: false,
        items: [item],
        nearby: new Map(),
        recalled: [],
        refreshNote: null,
      });

    it('gives the exact recorded window for a fresh forecast', () => {
      vi.spyOn(Date, 'now').mockReturnValue(
        Date.parse('2026-10-25T12:00:00.000Z'),
      );
      const text = answerFor(forecastItem()).paragraphs.join(' ');
      expect(text).toContain(`valid ${validFrom} to ${validTo}`);
      expect(text).toContain('worsening');
      expect(text).not.toContain('next 24');
    });

    it('does not describe an expired peak as an upcoming forecast', () => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(validTo));
      const answer = answerFor(forecastItem());
      const text = answer.paragraphs.join(' ');
      expect(text).toContain('expired');
      expect(text).toContain('No current forecast is available');
      expect(text).not.toContain('worsening');
      expect(text).not.toContain('next 24');
      expect(answer.citations[0]?.itemId).toBe(`hz-forecast-${KLANG.id}`);
    });

    it.each(['stale', 'retracted'] as const)(
      'does not use a %s forecast even within its window',
      (status) => {
        vi.spyOn(Date, 'now').mockReturnValue(
          Date.parse('2026-10-25T12:00:00.000Z'),
        );
        const text = answerFor(forecastItem(status)).paragraphs.join(' ');
        expect(text).toContain(`${status}; valid`);
        expect(text).toContain('No current forecast is available');
        expect(text).not.toContain('worsening');
      },
    );
  },
);

it('labels expired report forecasts and withholds their peak from current conditions', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(validTo));
  const report = composeTask({
    kind: 'scheduling',
    framing: new Manager().frame(
      { question: 'Plan a crew schedule for Klang', focusItemId: null },
      [KLANG],
    ),
    items: [forecastItem()],
    nearby: new Map(),
    refreshNote: null,
  });
  const table = report.blocks.find((b) => b.type === 'table');
  expect(table?.type).toBe('table');
  expect(JSON.stringify(table)).toContain(
    `expired; valid ${validFrom} to ${validTo}`,
  );
  expect(JSON.stringify(table)).toContain('No current forecast available');
  expect(JSON.stringify(table)).not.toContain('worsening');
});
