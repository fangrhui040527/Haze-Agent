import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { useAgentRun } from '../dashboard/useAgentRun.ts';
import { taskId } from '../../services/agents/testFixtures.ts';
import {
  DamageReductionPage,
  DamageReductionView,
} from './DamageReductionPage.tsx';
import { previewRun, previewView } from './preview-test-fixtures.ts';

vi.mock('../dashboard/useAgentRun.ts', () => ({ useAgentRun: vi.fn() }));
const render = (view = previewView()) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(DamageReductionView, { taskId, run: previewRun(), view }),
    ),
  );

describe('conditional planning preview page', () => {
  it('starts with explicit source intake and an opt-in synthetic example, without numerical default results', () => {
    const run = previewRun();
    run.task = null;
    run.status = 'idle';
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(DamageReductionView, { run }),
      ),
    );
    expect(html).toContain('Conditional planning preview');
    expect(html).toContain('Load synthetic engineering example');
    expect(html).toContain('type="file"');
    expect(html).toContain('Target fraction (0.1 = 10%)');
    expect(html).toContain('Proposed digital action and rules');
    expect(html).toContain('Add hard or subgroup constraint');
    expect(html).toContain('This preview sends no alerts');
    expect(html).not.toContain('>1000<');
    expect(html).not.toContain('Point estimate meets target');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Create conditional preview<\/button>/,
    );
  });
  it('renders three saved sections, exact server ratios, current review, origins and prerequisites', () => {
    const html = render();
    expect(html).toContain('id="reduction-target-heading"');
    expect(html).toContain('id="reduction-assessment-heading"');
    expect(html).toContain('id="reduction-plan-heading"');
    expect(html).toContain('Point estimate meets target');
    expect(html).toContain('120 / 1000');
    expect(html).toContain('synthetic engineering evidence');
    expect(html).toContain('Scientific qualification: unqualified');
    expect(html).toContain('Named non-synthetic reference case');
    expect(html).toContain('Inspect exact source');
    expect(html).toContain('Exact final plan review');
    expect(html).toContain('Achieved damage reduction is not established');
    expect(html).toContain('Continue in a new run');
    expect(html).toContain('Correct or clarify this task');
  });
  it('uses the server below-target label and keeps the conditional plan useful', () => {
    const view = previewView();
    view.claims!.point_estimate_label = 'does_not_meet';
    view.assessment!.value.target_met = false;
    view.assessment!.value.intervention_damage = '950';
    view.assessment!.value.absolute_reduction = '50';
    const html = render(view);
    expect(html).toContain('Point estimate does not meet target');
    expect(html).toContain('Reviewed conditional planning preview');
    expect(html).not.toContain('Point estimate meets target');
  });
  it('shows hard-constraint objections separately from a numerically successful scenario', () => {
    const view = previewView();
    view.plan_eligibility = 'blocked';
    view.plan!.value.state = 'blocked';
    view.plan!.value.objections = [
      {
        id: 'subgroup',
        severity: 'blocking',
        description:
          'The schedule violates the subgroup protection constraint.',
        evidence: [],
      },
    ];
    const html = render(view);
    expect(html).toContain('Point estimate meets target');
    expect(html).toContain('Blocked by unresolved constraints or objections');
    expect(html).toContain('Review objections');
    expect(html).toContain('subgroup protection constraint');
  });
  it('withholds current recommendations and target claims when historical evidence is stale', () => {
    const view = previewView();
    view.state = 'stale';
    view.plan_eligibility = 'none';
    const html = render(view);
    expect(html).toContain('Historical result');
    expect(html).toContain(
      'Evidence unavailable for a current target conclusion',
    );
    expect(html).toContain('Recommendations are withheld');
    expect(html).not.toContain('Point estimate meets target');
    expect(html).not.toContain('Conditional recommendations</h3>');
  });
  it('does not render a zero estimate when evidence is unavailable', () => {
    const view = previewView();
    view.assessment = null;
    view.plan = null;
    view.claims = null;
    view.state = 'unavailable';
    view.plan_eligibility = 'none';
    const html = render(view);
    expect(html).toContain(
      'Evidence unavailable: an assessment has not been saved',
    );
    expect(html).toContain(
      'Evidence unavailable: a conditional plan has not been saved',
    );
    expect(html).not.toContain('Point estimate meets target');
  });
  it('retains the server unavailable decision instead of treating it as a failed target', () => {
    const view = previewView();
    view.claims!.point_estimate_label = 'unavailable';
    const html = render(view);
    expect(html).toContain(
      'Evidence unavailable for a current target conclusion',
    );
    expect(html).not.toContain('Point estimate does not meet target');
  });
  it('restores a saved task from its explicit URL identifier', () => {
    vi.mocked(useAgentRun).mockReturnValue(previewRun());
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: [`/damage-reduction/tasks/${taskId}`] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/damage-reduction/tasks/:taskId',
            element: createElement(DamageReductionPage),
          }),
        ),
      ),
    );
    expect(useAgentRun).toHaveBeenCalledWith(taskId, 'haze.reduction.task.id', {
      restoreFromStorage: false,
    });
    expect(html).toContain('Saved planning task');
    expect(html).toContain(taskId);
    expect(html).toContain('reopening does not require browser memory');
  });
});
