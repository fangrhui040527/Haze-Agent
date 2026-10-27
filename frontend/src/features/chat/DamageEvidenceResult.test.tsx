import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DamageEvidenceResult } from './DamageEvidenceResult.tsx';

it('labels capture origin and separates retrieval from observation periods', () => {
  const html = renderToStaticMarkup(
    createElement(DamageEvidenceResult, {
      content: {
        capture: {
          schema_version: 'haze.damage.evidence.capture.v1',
          source_id: 'dosm-population',
          stage: 'validated',
          source_url: 'https://data.gov.my',
          raw_ref: `sha256:${'a'.repeat(64)}`,
          raw_sha256: 'a'.repeat(64),
          retrieved_at: '2026-10-27T00:00:00Z',
          evidence_origin: 'synthetic_fixture',
          observation_period: { start: '2024-01-01', end: '2024-12-31' },
          normalized_values: [
            {
              input: 'population',
              value: 1000,
              unit: 'persons',
              source_locator: '/csv/record/2/population',
            },
          ],
          gaps: ['Boundary version is unresolved.'],
        },
      },
    }),
  );
  expect(html).toContain('synthetic fixture');
  expect(html).toContain('2024-01-01 to 2024-12-31');
  expect(html).toContain(
    'Scientific applicability requires a separate review.',
  );
  expect(html).toContain('/csv/record/2/population');
  expect(html).toContain('Boundary version is unresolved.');
});
it('keeps unknown publication dates and treats retrieved markup as text', () => {
  const html = renderToStaticMarkup(
    createElement(DamageEvidenceResult, {
      content: {
        schema_version: 'haze.websearch.capture.v1',
        mode: 'fixture',
        evidence_origin: 'synthetic_fixture',
        provider: 'tavily',
        query: 'Malaysia haze',
        retrieved_at: '2026-10-27T00:00:00Z',
        response_sha256: 'a'.repeat(64),
        result_count: 1,
        results: [
          {
            title: 'Unreviewed source',
            url: 'https://example.org/source',
            snippet: '<script>untrusted()</script>',
          },
        ],
      },
    }),
  );
  expect(html).toContain('not supplied');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('Search results await review.');
});
