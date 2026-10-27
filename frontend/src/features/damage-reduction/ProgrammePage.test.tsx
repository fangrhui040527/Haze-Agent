import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { useAgentRun } from '../dashboard/useAgentRun.ts';
import { previewRun, previewView } from './preview-test-fixtures.ts';
import {
  ProgrammeAttempt,
  ProgrammeCapacity,
  ProgrammeListView,
  canRequestProgrammePhase,
} from './ProgrammeViews.tsx';
import {
  ProgrammeDetailView,
  ProgrammeHistoryView,
  ProgrammePhaseStarts,
  ProgrammeRecords,
  ReductionProgrammePage,
} from './ProgrammePage.tsx';
import {
  attemptId,
  programmeAttempt,
  programmeId,
  programmeView,
} from './programme-test-fixtures.ts';
import { artifactRef, taskId } from '../../services/agents/testFixtures.ts';

vi.mock('../dashboard/useAgentRun.ts', () => ({ useAgentRun: vi.fn() }));
vi.mocked(useAgentRun).mockReturnValue(previewRun());
const wrapped = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, element));
const mutate = vi.fn();

describe('programme coordination frontend', () => {
  it('renders server-calculated capacity without deriving allowance from task status', () => {
    const capacity = programmeView().capacity;
    capacity.remaining_model_calls = 17;
    capacity.charged_model_calls = 11;
    capacity.reserved_model_calls = 23;
    const html = wrapped(createElement(ProgrammeCapacity, { capacity }));
    expect(html).toContain('17 · charged 11 · reserved 23');
    expect(html).toContain('Runs remaining');
    expect(html).toContain('Assessment 3 · planning 3');
    expect(html).toContain('Server-calculated capacity');
  });
  it('requires explicit phase starts and disables them while one phase is active', () => {
    const view = programmeView();
    let html = wrapped(
      createElement(ProgrammePhaseStarts, { view, pending: false, mutate }),
    );
    expect(html).toContain('Start assessment phase');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Start planning phase from selected assessment<\/button>/,
    );
    expect(mutate).not.toHaveBeenCalled();
    view.capacity.active_attempt_id = attemptId;
    html = wrapped(
      createElement(ProgrammePhaseStarts, { view, pending: false, mutate }),
    );
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Start assessment phase<\/button>/,
    );
    expect(canRequestProgrammePhase(view, 'assessment')).toBe(false);
  });
  it('does not offer exhausted or currently pending admission capacity', () => {
    const view = programmeView();
    expect(canRequestProgrammePhase(view, 'assessment', true)).toBe(false);
    view.capacity.remaining_attempts.assessment = 0;
    expect(canRequestProgrammePhase(view, 'assessment')).toBe(false);
    view.capacity.remaining_attempts.assessment = 3;
    view.capacity.remaining_runs = 0;
    expect(canRequestProgrammePhase(view, 'assessment')).toBe(false);
  });
  it('offers only exact server-current completed assessments as planning dependencies', () => {
    const view = programmeView();
    const current = {
      attempt: programmeAttempt(),
      execution_status: 'completed' as const,
      currency: 'current' as const,
      result_status: 'gap' as const,
      preview: null,
      historical_artifact_refs: [],
      reasons: [],
    };
    const staleId = '99999999-9999-4999-8999-999999999999';
    view.attempts = [
      current,
      {
        ...current,
        attempt: { ...current.attempt, id: staleId, run_id: staleId },
        currency: 'stale',
      },
    ];
    const html = wrapped(
      createElement(ProgrammePhaseStarts, { view, pending: false, mutate }),
    );
    expect(html).toContain(`value="${attemptId}"`);
    expect(html).not.toContain(`value="${staleId}"`);
    expect(html).toContain(current.attempt.run_id);
    expect(mutate).not.toHaveBeenCalled();
  });
  it('retains the server-current assessment when a cost revision stales planning only', () => {
    const view = programmeView();
    view.programme.revision = 3;
    view.programme.preview.candidate.costs[0]!.description =
      'Revised service operating costs';
    const assessmentPreview = previewView();
    assessmentPreview.plan = null;
    assessmentPreview.plan_review = null;
    assessmentPreview.plan_eligibility = 'none';
    view.attempts = [
      {
        attempt: programmeAttempt(),
        execution_status: 'completed',
        currency: 'current',
        result_status: 'available',
        preview: assessmentPreview,
        historical_artifact_refs: [],
        reasons: [],
      },
      {
        attempt: {
          ...programmeAttempt('planning'),
          id: '99999999-9999-4999-8999-999999999999',
        },
        execution_status: 'completed',
        currency: 'stale',
        result_status: 'unavailable',
        preview: null,
        historical_artifact_refs: [artifactRef],
        reasons: [
          'Candidate costs changed; planning requires a new explicit attempt.',
        ],
      },
    ];
    const html = wrapped(
      createElement(ProgrammeDetailView, {
        view,
        pending: false,
        mutate,
        onError: vi.fn(),
      }),
    );
    expect(html).toContain('Point estimate meets target');
    expect(html).toContain(
      'Candidate costs changed; planning requires a new explicit attempt',
    );
    expect(html).toContain('Current programme: revision');
    expect(html).not.toContain('Reviewed conditional planning preview');
  });
  it('shows exact task/run binding, current result and reservation independently', () => {
    const entry = {
      attempt: programmeAttempt(),
      execution_status: 'completed' as const,
      currency: 'current' as const,
      result_status: 'available' as const,
      preview: previewView(),
      historical_artifact_refs: [],
      reasons: [],
    };
    const html = wrapped(createElement(ProgrammeAttempt, { entry }));
    expect(html).toContain(entry.attempt.run_id);
    expect(html).toContain('objective revision 1');
    expect(html).toContain(`href="/damage-reduction/tasks/${taskId}"`);
    expect(html).toContain('40 model calls · 40 tool calls');
    expect(html).toContain('Point estimate meets target');
    expect(html).toContain('A task workspace can contain later runs');
    expect(html).toContain(
      `id="programme-attempt-${attemptId}-target-heading"`,
    );
  });
  it('withholds current claims from a historical attempt even if its old preview claimed current', () => {
    const entry = {
      attempt: programmeAttempt(),
      execution_status: 'completed' as const,
      currency: 'historical' as const,
      result_status: 'available' as const,
      preview: previewView(),
      historical_artifact_refs: [artifactRef],
      reasons: ['A later explicit attempt supersedes this use.'],
    };
    const html = wrapped(createElement(ProgrammeAttempt, { entry }));
    expect(html).toContain('historical');
    expect(html).toContain('Historical result');
    expect(html).not.toContain('Point estimate meets target');
    expect(html).toContain(
      'Historical artifacts do not establish a current programme result',
    );
  });
  it('renders evidence gaps and stale reasons without following a task successor', () => {
    const entry = {
      attempt: programmeAttempt(),
      execution_status: 'completed' as const,
      currency: 'stale' as const,
      result_status: 'gap' as const,
      preview: null,
      historical_artifact_refs: [artifactRef],
      reasons: ['The selected original is held for this programme use.'],
    };
    const html = wrapped(createElement(ProgrammeAttempt, { entry }));
    expect(html).toContain('The selected original is held');
    expect(html).toContain('gap');
    expect(html).toContain('exact linked run');
    expect(html).not.toContain('Point estimate meets target');
  });
  it('keeps notes and attached previews explicitly historical with exact original task lineage', () => {
    const view = programmeView();
    view.records = [
      {
        id: attemptId,
        programme_id: programmeId,
        programme_revision: 2,
        created_at: '2026-10-27T00:02:00Z',
        record: {
          kind: 'attachment',
          artifact: artifactRef,
          description: 'Prior standalone preview for historical context.',
        },
        task_binding: {
          task_id: taskId,
          run_id: programmeAttempt().run_id,
          objective_revision: 1,
        },
        applicability: 'historical_context',
      },
    ];
    const html = wrapped(createElement(ProgrammeRecords, { view }));
    expect(html).toContain('Prior standalone preview for historical context');
    expect(html).toContain(
      'does not recreate its reservation or make its result current',
    );
    expect(html).toContain(artifactRef.sha256);
    expect(html).not.toContain('Point estimate meets target');
  });
  it('shows unchanged-note history and material invalidation as separate server facts', () => {
    const view = programmeView();
    const history = {
      schema_version: 'haze.reduction.programme.history.v1' as const,
      next_offset: null,
      attempts: [],
      records: [],
      revisions: [
        {
          programme_id: programmeId,
          revision: 2,
          previous_revision: 1,
          kind: 'record' as const,
          reason: 'Append unrelated note',
          snapshot: view.programme,
          invalidated_phases: [],
          created_at: '2026-10-27T00:02:00Z',
        },
        {
          programme_id: programmeId,
          revision: 3,
          previous_revision: 2,
          kind: 'inputs' as const,
          reason: 'Change population',
          snapshot: view.programme,
          invalidated_phases: ['assessment' as const, 'planning' as const],
          created_at: '2026-10-27T00:03:00Z',
        },
      ],
    };
    const html = wrapped(createElement(ProgrammeHistoryView, { history }));
    expect(html).toContain('No phase was invalidated');
    expect(html).toContain('Affected phases: assessment, planning');
    expect(html).toContain(
      'Current eligibility comes from the programme projection',
    );
  });
  it('provides programme selection links while preserving standalone preview navigation', () => {
    const html = wrapped(
      createElement(ProgrammeListView, {
        page: {
          schema_version: 'haze.reduction.programme.list.v1',
          programmes: [programmeView().programme],
          next_offset: null,
        },
        currentId: programmeId,
      }),
    );
    expect(html).toContain(
      `href="/damage-reduction/programmes/${programmeId}"`,
    );
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Synthetic alert programme');
  });
  it('renders owners, revisions, inputs and guarded record/revision controls', () => {
    const html = wrapped(
      createElement(ProgrammeDetailView, {
        view: programmeView(),
        pending: false,
        mutate,
        onError: vi.fn(),
      }),
    );
    expect(html).toContain('Accountable owner');
    expect(html).toContain('Scientific owner');
    expect(html).toContain('No achieved reduction is established');
    expect(html).toContain('Load current exact inputs for editing');
    expect(html).toContain('Append note');
    expect(html).toContain('Attach exact reference');
    expect(html).toContain('Programme revision and admission history');
    expect(html).not.toContain('Register pilot');
  });
  it('opens a saved programme from its route while keeping creation separate', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: [`/damage-reduction/programmes/${programmeId}`] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/damage-reduction/programmes/:programmeId',
            element: createElement(ReductionProgrammePage),
          }),
        ),
      ),
    );
    expect(html).toContain(programmeId);
    expect(html).toContain('Rechecking the saved programme');
    expect(html).not.toContain('Save programme inputs</button>');
  });
  it('opens explicit programme creation without reading the browser saved task', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/damage-reduction/programmes/new'] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/damage-reduction/programmes/:programmeId',
            element: createElement(ReductionProgrammePage),
          }),
        ),
      ),
    );
    expect(useAgentRun).toHaveBeenCalledWith(
      undefined,
      'haze.reduction.programme.create',
      { restoreFromStorage: false },
    );
    expect(html).toContain('Save a programme');
    expect(html).toContain('Save programme inputs');
    expect(html).toContain('Accountable owner');
    expect(html).toContain(
      'Start each assessment or planning phase explicitly',
    );
    expect(html).not.toContain('Create conditional preview</button>');
  });
});
