import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { useAgentRun } from '../dashboard/useAgentRun.ts';
import {
  EvaluationTaskResults,
  ProgrammeEvaluationResults,
} from './EvaluationResults.tsx';
import {
  ProgrammeEvaluationInputEditor,
  ProgrammeEvaluationRecordEditor,
} from './ProgrammeEvaluation.tsx';
import { ProgrammeAttempt } from './ProgrammeViews.tsx';
import { ProgrammePhaseStarts, ProgrammeRecords } from './ProgrammePage.tsx';
import {
  evaluationProjection,
  evaluationTask,
} from './evaluation-test-fixtures.ts';
import {
  programmeView,
  programmeAttempt,
  programmeId,
  attemptId,
} from './programme-test-fixtures.ts';
import { previewRun } from './preview-test-fixtures.ts';
import { artifactRef, runId } from '../../services/agents/testFixtures.ts';

vi.mock('../dashboard/useAgentRun.ts', () => ({ useAgentRun: vi.fn() }));
vi.mocked(useAgentRun).mockReturnValue(previewRun());
const wrapped = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, element));

describe('external evaluation and learning frontend', () => {
  it('renders engineering arithmetic with exact lineage and explicit reproduction limits', () => {
    const view = programmeView();
    view.evaluation = evaluationProjection();
    const html = wrapped(createElement(ProgrammeEvaluationResults, { view }));
    expect(html).toContain('Point estimate meets target.');
    expect(html).toContain('synthetic');
    expect(html).toContain('Server qualification: <strong>unqualified');
    expect(html).not.toContain(
      'External evaluation supports the registered target',
    );
    expect(html).toContain(
      'operational release or an achieved-effect conclusion',
    );
    expect(html).toContain('Exact evaluated registered protocol');
    expect(html).toContain('fixture-rule');
    expect(html).toContain('What Haze reproduced');
    expect(html).toContain('What remains externally calculated');
    expect(html).toContain('Causal estimator and uncertainty calculation');
    expect(html).toContain('1000 / 880');
    expect(html).toContain('120 / 1000');
    expect(html).toContain('Current reviewed lessons');
    expect(html).toContain('not published');
  });
  it('uses only the governed eligible label for an external target conclusion', () => {
    const view = programmeView();
    const projection = evaluationProjection();
    view.evaluation = projection;
    projection.qualification.status = 'qualified';
    projection.claim.label = 'external_evaluation_supports_registered_target';
    let html = wrapped(createElement(ProgrammeEvaluationResults, { view }));
    expect(html).toContain('External target conclusion withheld');
    expect(html).not.toContain(
      'External evaluation supports the registered target',
    );
    projection.current!.result!.value.origin = 'supplied';
    projection.claim.eligible = true;
    projection.operational_release = 'qualified_reference_trace_supported';
    projection.achieved_reduction = true;
    html = wrapped(createElement(ProgrammeEvaluationResults, { view }));
    expect(html).toContain(
      'External evaluation supports the registered target',
    );
    expect(html).toContain('retained human attestation');
    expect(html).toContain(
      'qualified reference trace for the stated physical method and claim',
    );
    expect(html).not.toContain('Operational release: gated pending');
  });
  it('retains below-target and unsupported uncertainty as completed outcomes with gaps', () => {
    const view = programmeView();
    view.evaluation = evaluationProjection();
    view.evaluation.claim.label = 'point_estimate_below_target';
    view.evaluation.claim.point_estimate = 'below';
    let html = wrapped(createElement(ProgrammeEvaluationResults, { view }));
    expect(html).toContain('Point estimate is below target');
    expect(html).toContain('insufficient-evidence result is valid completion');
    const task = evaluationTask();
    task.state = 'evidence_gap';
    task.result!.value.criterion.kind = 'probability';
    task.result!.value.target_met = null;
    html = wrapped(createElement(EvaluationTaskResults, { view: task }));
    expect(html).toContain(
      'does not support an uncertainty-bound or probability criterion',
    );
    expect(html).toContain('point estimate does not substitute');
    expect(html).toContain('Current reviewed lessons');
    expect(html).toContain('evidence gap');
  });
  it('shows withdrawn qualification, supersession and unresolved material objections separately', () => {
    const view = programmeView();
    view.evaluation = evaluationProjection();
    view.evaluation.qualification.status = 'withdrawn';
    view.evaluation.qualification.reasons = [
      'The scientific adoption was withdrawn.',
    ];
    view.evaluation.qualifications = [
      {
        record_id: attemptId,
        decision: 'qualified',
        currency: 'superseded',
        reasons: ['Retained former decision.'],
      },
      {
        record_id: runId,
        decision: 'withdrawn',
        currency: 'current',
        reasons: [],
      },
    ];
    view.evaluation.objections = [
      {
        record_id: programmeId,
        unresolved: true,
        material: true,
        reasons: ['A source was held.'],
      },
    ];
    view.records = [
      {
        id: runId,
        programme_id: programmeId,
        programme_revision: 2,
        created_at: '2026-10-27T00:00:00Z',
        task_binding: null,
        applicability: 'programme_record',
        record: {
          kind: 'evaluation_qualification',
          decision: 'withdrawn',
          result_ref: artifactRef,
          technical_review_ref: artifactRef,
          dossier_ref: artifactRef,
          adopted_by: 'Local scientific owner',
          attested_at: '2026-10-27T00:00:00Z',
          reason: 'Withdraw after a material source issue.',
          supersedes_record_id: attemptId,
        },
      },
    ];
    const html = wrapped(createElement(ProgrammeEvaluationResults, { view }));
    expect(html).toContain('Server qualification: <strong>withdrawn');
    expect(html).toContain('superseded');
    expect(html).toContain('Unresolved material objection');
    expect(html).toContain('Exact qualification lineage');
    expect(html).toContain('Withdraw after a material source issue');
    expect(html).not.toContain(
      'External evaluation supports the registered target',
    );
    expect(wrapped(createElement(ProgrammeRecords, { view }))).toContain(
      'evaluation_qualification',
    );
  });
  it('keeps stale/historical lessons and task bindings out of current labels', () => {
    const task = evaluationTask();
    task.state = 'stale';
    let html = wrapped(createElement(EvaluationTaskResults, { view: task }));
    expect(html).toContain('Retained external comparison');
    expect(html).not.toContain('Current reviewed lessons');
    html = wrapped(
      createElement(ProgrammeAttempt, {
        entry: {
          attempt: {
            ...programmeAttempt(),
            phase: 'evaluation',
            registration_id: attemptId,
          },
          execution_status: 'completed',
          currency: 'historical',
          result_status: 'available',
          preview: null,
          evaluation: evaluationTask(),
          historical_artifact_refs: [artifactRef],
          reasons: [],
        },
      }),
    );
    expect(html).toContain('Bound evaluation registration');
    expect(html).toContain('historical');
    expect(html).not.toContain('Current reviewed lessons');
  });
  it('requires explicit import revision, registration selection and phase start without rendering mutations', () => {
    const view = programmeView();
    view.programme.evaluation_input_ref = artifactRef;
    view.capacity.remaining_attempts.evaluation = 3;
    view.records = [
      {
        id: attemptId,
        programme_id: programmeId,
        programme_revision: 1,
        created_at: '2026-10-27T00:00:00Z',
        task_binding: null,
        applicability: 'programme_record',
        record: {
          kind: 'pilot_registration',
          protocol_ref: artifactRef,
          feasibility_ref: artifactRef,
          review_ref: artifactRef,
          outcome_access: {
            collection: 'unknown',
            analysis: 'unknown',
            collection_started_at: null,
            analysis_started_at: null,
            attested_by: 'Synthetic operator',
            attested_at: '2026-10-27T00:00:00Z',
            evidence: [],
          },
          external_registration: null,
        },
      },
    ];
    const mutate = vi.fn(),
      props = { view, pending: false, mutate, onError: vi.fn() };
    const html = wrapped(
      createElement(
        'div',
        null,
        createElement(ProgrammeEvaluationInputEditor, props),
        createElement(ProgrammeEvaluationRecordEditor, props),
        createElement(ProgrammePhaseStarts, props),
      ),
    );
    expect(html).toContain('Save evaluation-input revision');
    expect(html).toContain('Explicitly clear the selected scientific dossier');
    expect(html).toContain('Scientific qualification adoption or withdrawal');
    expect(html).toContain('Evaluation objection or resolution');
    expect(html).toContain('maxLength="65536"');
    expect(html).toContain(`value="${attemptId}"`);
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Start external evaluation from selected registration<\/button>/,
    );
    expect(html).toContain('Imported approval flags');
    expect(mutate).not.toHaveBeenCalled();
    expect(useAgentRun).toHaveBeenCalledWith(
      undefined,
      'haze.reduction.evaluation.inputs',
      { restoreFromStorage: false },
    );
  });
  it('withholds conclusions when the governed projection is unavailable despite an imported result flag', () => {
    const html = wrapped(
      createElement(ProgrammeEvaluationResults, { view: programmeView() }),
    );
    expect(html).toContain(
      'No conclusion is inferred from imported approval flags',
    );
    expect(html).not.toContain('Point estimate meets target');
  });
});
