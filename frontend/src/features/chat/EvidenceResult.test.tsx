import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  artifactRef,
  artifactId,
  fixtureResult,
} from '../../services/agents/testFixtures.ts';
import { TaskResult } from './TaskResult.tsx';
import { EvidenceResult } from './EvidenceResult.tsx';
describe('general result shell and optional domain details', () => {
  it('renders generic results, pinned sources, review, and work products without domain fields', () => {
    const result = fixtureResult();
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(TaskResult, {
          evidence: { taskUrl: '/api/tasks/fixture', result },
        }),
      ),
    );
    expect(markup).toContain('Work products');
    expect(markup).toContain('href="/task/fixture"');
    expect(markup).toContain('Open task report');
    expect(markup).toContain('Exact source');
    expect(markup).toContain('Result: partial. Review: needs review.');
    expect(markup).toContain('Observations are unavailable.');
    expect(markup).toContain('Provide direct observations.');
    expect(markup).toContain('Mode: fixture.');
    expect(markup).not.toContain('PM2.5 evidence coverage');
  });
  it('labels stale historical results and preserves rejected-review limitations', () => {
    const result = fixtureResult();
    result.currency = 'stale';
    result.review.status = 'rejected';
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(TaskResult, {
          evidence: { taskUrl: '/api/tasks/fixture', result },
        }),
      ),
    );
    expect(markup).toContain('Stale result');
    expect(markup).toContain('Review: rejected');
    expect(markup).toContain('Fixture verification only.');
  });
  it('renders PM2.5 coverage only when the work product has a matching shape', () => {
    const markup = renderToStaticMarkup(
      createElement(EvidenceResult, {
        content: {
          coverage: {
            status: 'partial',
            usable_row_count: 1,
            modeled_count: 1,
            observation_count: 0,
            unknown_kind_count: 0,
            requested: {
              location: 'Fixture location',
              period: { start: '2026-10-23', end: '2026-10-24' },
            },
            missing_intervals: [
              { start: '2026-10-23T01:00Z', end: '2026-10-24' },
            ],
          },
        },
      }),
    );
    expect(markup).toContain('1 modeled, 0 observations');
    expect(markup).toContain('Missing coverage intervals (1)');
    expect(
      renderToStaticMarkup(
        createElement(EvidenceResult, {
          content: { summary: 'Generic analysis' },
        }),
      ),
    ).toBe('');
  });
  it('withholds a rejected artifact independently of aggregate review, tied to its exact version', () => {
    const result = fixtureResult();
    result.review.checks = [
      {
        artifact: artifactRef,
        producer_assignment_id: artifactId,
        producer_revision: 2,
        verdict: 'rejected',
        limitations: ['Missing numerical support.'],
      },
    ];
    const render = () =>
      renderToStaticMarkup(
        createElement(
          MemoryRouter,
          null,
          createElement(TaskResult, {
            evidence: { taskUrl: '/api/tasks/fixture', result },
          }),
        ),
      );
    expect(render()).toContain(
      'This artifact was rejected in review. Domain calculations are withheld.',
    );
    result.review.checks[0].artifact = { ...artifactRef, version: 2 };
    expect(render()).not.toContain(
      'This artifact was rejected in review. Domain calculations are withheld.',
    );
  });
});
