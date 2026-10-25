import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskResult } from '../../../../app/tasks/contracts.ts';
import type { OrchestrationResult } from '../../../../app/orchestration/contracts.ts';
import { EvidenceResult } from './EvidenceResult.tsx';

function fixtureResult(): TaskResult {
  return {
    answer: 'Fixture only.',
    findings: [{ text: 'One modeled row.', citation_ids: ['e1'] }],
    citations: [
      {
        id: 'e1',
        artifact_id: 'artifact',
        url: '/api/tasks/fixture/artifacts/exact',
        sha256: 'a'.repeat(64),
        label: 'Evidence',
        selection: {},
      },
    ],
    coverage: {
      requested: {
        location: 'Fixture location',
        period: {
          start: '2026-10-23T00:00:00Z',
          end: '2026-10-24T00:00:00Z',
        },
      },
      row_count: 1,
      usable_row_count: 1,
      modeled_count: 1,
      observation_count: 0,
      unknown_kind_count: 0,
      missing_intervals: [
        { start: '2026-10-23T01:00:00Z', end: '2026-10-24T00:00:00Z' },
      ],
      status: 'partial',
    },
    assumptions: [],
    unresolved_gaps: ['No observations.'],
    review: {
      status: 'deterministic_checks',
      scope: 'Citation and interval validation only.',
      limitations: [],
      artifact_id: 'artifact',
    },
    provenance: {
      mode: 'live',
      source: 'test-only-fixture',
      retrieved_at: '2026-10-24T00:00:00Z',
      tool_calls: 1,
      method: 'haze.pm25.coverage.v1',
      model: {
        provider: 'fixture-provider',
        model: 'fixture-model',
        calls: 1,
        max_output_tokens: 2000,
        usage: 'not_reported_by_adapter',
      },
    },
  };
}

describe('evidence result presentation', () => {
  it('withholds rejected coverage while keeping review limits and saved evidence accessible', () => {
    const base = fixtureResult();
    const result: OrchestrationResult = {
      ...base,
      schema_version: 'haze.task.result.v2',
      completion: 'blocked',
      findings: [],
      assumptions: [],
      coverage: null,
      review: {
        ...base.review,
        status: 'rejected',
        limitations: ['Coverage failed independent verification.'],
      },
      provenance: { ...base.provenance, mode: 'fixture' },
    };
    const markup = renderToStaticMarkup(
      createElement(EvidenceResult, {
        evidence: { taskUrl: '/api/tasks/fixture', result },
        citations: [],
      }),
    );
    expect(markup).toContain('Result: blocked. Review: rejected.');
    expect(markup).toContain(
      'Coverage calculations were withheld after evidence review.',
    );
    expect(markup).toContain('Coverage failed independent verification.');
    expect(markup).toContain('href="/api/tasks/fixture"');
    expect(markup).not.toContain('1 modeled');
    expect(markup).not.toContain('Missing coverage intervals');
    expect(markup).not.toContain('Supported findings');
  });
  it('shows partial fixture completion and review limitations without claiming live execution', () => {
    const base = fixtureResult();
    const result: OrchestrationResult = {
      ...base,
      schema_version: 'haze.task.result.v2',
      completion: 'partial',
      review: {
        ...base.review,
        status: 'needs_review',
        limitations: ['Independent review is pending.'],
      },
      provenance: { ...base.provenance, mode: 'fixture' },
    };
    const markup = renderToStaticMarkup(
      createElement(EvidenceResult, {
        evidence: { taskUrl: '/api/tasks/fixture', result },
        citations: [],
      }),
    );
    expect(markup).toContain('Result: partial. Review: needs review.');
    expect(markup).toContain('Some requested evidence remains unavailable.');
    expect(markup).toContain('Independent review is pending.');
    expect(markup).toContain('Mode: fixture.');
  });

  it('shows missing intervals, source kind counts, exact citations and scoped review', () => {
    const result = fixtureResult();
    const markup = renderToStaticMarkup(
      createElement(EvidenceResult, {
        evidence: { taskUrl: '/api/tasks/fixture', result },
        citations: result.citations.map((citation) => ({
          ...citation,
          href: citation.url,
          itemId: null,
        })),
      }),
    );
    expect(markup).toContain('1 modeled, 0 observations');
    expect(markup).toContain('Missing coverage intervals (1)');
    expect(markup).toContain(result.coverage.missing_intervals[0]!.start);
    expect(markup).toContain(`href="${result.citations[0]!.url}"`);
    expect(markup).toContain('Citation and interval validation only.');
    expect(markup).toContain('fixture-provider / fixture-model; 1 call(s)');
    expect(markup).toContain('No observations.');
  });
});
