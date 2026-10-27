import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReductionResults } from './ReductionResults.tsx';
import { previewView } from './preview-test-fixtures.ts';

describe('recorded reduction preview rendering', () => {
  it('labels captured support and provides recorded source inspection without reading the live service on render', () => {
    const readArtifact = vi.fn(() =>
      Promise.reject(new Error('Inspection requires an explicit click.')),
    );
    const markup = renderToStaticMarkup(
      createElement(ReductionResults, {
        view: previewView(),
        recorded: true,
        readArtifact,
      }),
    );
    expect(markup).toContain('Recorded synthetic example.');
    expect(markup).toContain('current live eligibility is not rechecked');
    expect(markup).toContain('At capture: Point estimate meets target');
    expect(markup).toContain('Arithmetic review at capture');
    expect(markup).toContain('Plan review at capture');
    expect(markup).toContain('Recorded conditional planning preview');
    expect(markup).toContain('Inspect recorded source');
    expect(markup).toContain('Live access and applicability are not rechecked');
    expect(markup).not.toContain('Inspect exact source');
    expect(markup).not.toContain('Source inspection rechecks access.');
    expect(markup).not.toContain('/api/');
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it('keeps withheld target claims and recommendations withheld in a recorded stale result', () => {
    const view = previewView();
    view.state = 'stale';
    view.plan_eligibility = 'none';
    const markup = renderToStaticMarkup(
      createElement(ReductionResults, { view, recorded: true }),
    );
    expect(markup).toContain('current claim eligibility is withheld');
    expect(markup).toContain('Recommendations are withheld');
    expect(markup).not.toContain('At capture: Point estimate meets target');
    expect(markup).not.toContain('Conditional recommendations</h3>');
  });

  it('preserves the default live review and source wording', () => {
    const markup = renderToStaticMarkup(
      createElement(ReductionResults, { view: previewView() }),
    );
    expect(markup).toContain('Point estimate meets target');
    expect(markup).toContain('Independent arithmetic review');
    expect(markup).toContain('Independent plan review');
    expect(markup).toContain('Inspect exact source');
    expect(markup).toContain('Source inspection rechecks access.');
    expect(markup).not.toContain('Recorded synthetic example.');
  });
});
