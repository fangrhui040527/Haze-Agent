import { describe, expect, it } from 'vitest';
import { composeAnswer } from './answers.ts';
import { generateDataset } from './generator/generate.ts';

const NOW = new Date('2026-10-23T12:00:00Z');
const dataset = generateDataset({ seed: 3, itemCount: 200, now: NOW });

describe('composeAnswer (mock agents)', () => {
  it('detects places and the compare intent', () => {
    const answer = composeAnswer(
      'Compare Kuala Lumpur and Johor Bahru today',
      dataset,
      NOW.getTime(),
    );
    expect(answer.intent).toBe('compare');
    expect(answer.locations.map((l) => l.name).slice(0, 2)).toEqual([
      'Kuala Lumpur',
      'Johor Bahru',
    ]);
    expect(answer.paragraphs.join(' ')).toContain('Johor Bahru');
  });

  it('never contradicts the numbers it quotes when comparing', () => {
    for (const q of [
      'Compare Kuala Lumpur and Johor Bahru',
      'Compare Singapore and Pekanbaru',
      'Compare Kuching and Pontianak',
    ]) {
      const text = composeAnswer(q, dataset, NOW.getTime()).paragraphs.join(
        ' ',
      );
      const values = [...text.matchAll(/(\p{L}[\p{L} ]*): PM2\.5 (\d+)/gu)].map(
        (m) => ({ name: m[1].trim(), pm: Number(m[2]) }),
      );
      if (values.length === 2 && values[0].pm !== values[1].pm) {
        const higher = values[0].pm > values[1].pm ? values[0] : values[1];
        expect(text, q).toContain(`${higher.name} has the higher PM2.5`);
      }
    }
  });

  it('matches place names without accents', () => {
    const worldwide = generateDataset({
      seed: 3,
      itemCount: 200,
      now: NOW,
      coverage: 'worldwide',
    });
    expect(
      composeAnswer('haze in Krakow?', worldwide, NOW.getTime()).locations[0]
        ?.name,
    ).toBe('Kraków');
  });

  it('finds every Malaysian place when asked about the country', () => {
    const names = composeAnswer(
      "What's new in Malaysia?",
      dataset,
      NOW.getTime(),
    ).locations.map((l) => l.countryCode);
    expect(names.length).toBeGreaterThan(1);
    expect(names.every((c) => c === 'MY')).toBe(true);
  });

  it('never gives medical advice for health questions', () => {
    const text = composeAnswer(
      'Is it safe to run outside in Jakarta?',
      dataset,
      NOW.getTime(),
    ).paragraphs.join(' ');
    expect(text).toContain('not medical advice');
  });

  it('always labels the answer as demo data and cites items', () => {
    const answer = composeAnswer(
      "What's the haze situation in Pekanbaru?",
      dataset,
      NOW.getTime(),
    );
    expect(answer.paragraphs.at(-1)).toContain('fictional');
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.paragraphs.join(' ')).not.toMatch(/\{\w+\}/);
  });
});
