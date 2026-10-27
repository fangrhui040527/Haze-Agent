import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { useAgentRun } from '../dashboard/useAgentRun.ts';
import { PilotDeliveryResults, PilotTaskResults } from './PilotResults.tsx';
import {
  ProgrammePilotInputEditor,
  ProgrammePilotRecordEditor,
} from './ProgrammePilot.tsx';
import { ProgrammeAttempt } from './ProgrammeViews.tsx';
import { ProgrammePhaseStarts, ProgrammeRecords } from './ProgrammePage.tsx';
import { pilotProjection, pilotTaskView } from './pilot-test-fixtures.ts';
import {
  programmeAttempt,
  programmeId,
  programmeView,
  attemptId,
} from './programme-test-fixtures.ts';
import { previewRun, previewView } from './preview-test-fixtures.ts';
import { artifactRef, runId } from '../../services/agents/testFixtures.ts';

vi.mock('../dashboard/useAgentRun.ts', () => ({ useAgentRun: vi.fn() }));
vi.mocked(useAgentRun).mockReturnValue(previewRun());
const wrapped = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, element));

describe('pilot and delivery programme views', () => {
  it('keeps scientific gaps, supplied origin, draft and exact independent review visible', () => {
    const html = wrapped(
      createElement(PilotTaskResults, { view: pilotTaskView() }),
    );
    expect(html).toContain('delivery exposure feasibility only');
    expect(html).toContain(
      'Design-specific precision calculations have not been supplied',
    );
    expect(html).toContain(
      'Supply design-specific power and scientific review',
    );
    expect(html).toContain('synthetic');
    expect(html).toContain('engineering completeness only');
    expect(html).toContain('Exact feasibility artifact');
    expect(html).toContain('Exact protocol draft');
    expect(html).toContain('Exact independent pilot review');
    expect(html).toContain('fixture-alert');
    expect(html).toContain('version 2');
    expect(html).toContain('Live execution is deferred');
    expect(html).toContain('Achieved damage reduction is not established');
    expect(html).not.toContain('Register and execute');
  });
  it('withholds current classification for stale or unsupported drafts', () => {
    const view = pilotTaskView();
    view.state = 'stale';
    let html = wrapped(createElement(PilotTaskResults, { view }));
    expect(html).toContain('Historical pilot draft');
    expect(html).toContain('Retained classification');
    expect(html).not.toContain('Current classification');
    view.state = 'current';
    view.review!.value.verdict = 'rejected';
    html = wrapped(createElement(PilotTaskResults, { view }));
    expect(html).toContain('Current pilot draft support is unavailable');
    expect(html).not.toContain('Current classification');
  });
  it('separates original registered protocol, outcome timing and exploratory amendments', () => {
    const view = programmeView();
    const projection = pilotProjection();
    const laterProtocol = { ...artifactRef, version: 2 };
    projection.registrations = [
      {
        record_id: attemptId,
        protocol_ref: artifactRef,
        effective_protocol_ref: laterProtocol,
        recorded_at: '2026-10-27T10:00:00Z',
        timing: 'late_or_outcome_aware',
        currency: 'stale',
        analysis_status: 'exploratory',
        reasons: ['Outcomes were available before this append.'],
      },
    ];
    projection.amendments = [
      {
        record_id: runId,
        registration_id: attemptId,
        status: 'exploratory',
        reasons: ['Endpoint changed after outcome access.'],
      },
    ];
    view.pilot = projection;
    view.records = [
      {
        id: attemptId,
        programme_id: programmeId,
        programme_revision: 2,
        created_at: '2026-10-27T10:00:00Z',
        task_binding: null,
        applicability: 'programme_record',
        record: {
          kind: 'pilot_registration',
          feasibility_ref: artifactRef,
          protocol_ref: artifactRef,
          review_ref: artifactRef,
          outcome_access: {
            collection: 'started',
            analysis: 'complete',
            collection_started_at: '2026-10-26T00:00:00Z',
            analysis_started_at: '2026-10-26T05:00:00Z',
            attested_by: 'Synthetic operator',
            attested_at: '2026-10-27T09:00:00Z',
            evidence: [],
          },
          external_registration: null,
        },
      },
    ];
    const html = wrapped(createElement(PilotDeliveryResults, { view }));
    expect(html).toContain('late or outcome aware');
    expect(html).toContain('Outcome collection access');
    expect(html).toContain('2026-10-26T05:00:00Z');
    expect(html).toContain('Haze registration recorded at');
    expect(html).toContain('Original immutable registered protocol');
    expect(html).toContain('earlier prespecification');
    expect(html).toContain('exploratory');
    expect(html).toContain('do not replace the original registered analysis');
  });
  it('shows simulations, unknown/failure, confirmation levels, stale delivery and partial independent coverage', () => {
    const view = programmeView();
    const projection = pilotProjection();
    projection.actions = [
      {
        record_id: attemptId,
        action_id: 'synthetic-action',
        origin: 'simulated',
        effective_status: 'simulated',
        confirmation_level: 'alert_received',
        recorded_delivery: true,
        independent_verification: 'none',
        currency: 'current',
        reasons: [],
      },
      {
        record_id: runId,
        action_id: 'unknown-action',
        origin: 'imported_service',
        effective_status: 'unknown',
        confirmation_level: 'provider_accepted',
        recorded_delivery: false,
        independent_verification: 'partial',
        currency: 'current',
        reasons: ['Receipt is missing.'],
      },
      {
        record_id: programmeId,
        action_id: 'failed-action',
        origin: 'imported_service',
        effective_status: 'failed',
        confirmation_level: 'none',
        recorded_delivery: false,
        independent_verification: 'none',
        currency: 'current',
        reasons: ['Provider reported failure.'],
      },
      {
        record_id: '99999999-9999-4999-8999-999999999999',
        action_id: 'old-action',
        origin: 'imported_service',
        effective_status: 'confirmed',
        confirmation_level: 'schedule_applied',
        recorded_delivery: true,
        independent_verification: 'verified',
        currency: 'stale',
        reasons: ['Rule version changed.'],
      },
    ];
    projection.deviations = [
      {
        record_id: runId,
        unresolved: true,
        material: true,
        reasons: ['Schedule departed from approved rule.'],
      },
    ];
    projection.verifications = [
      {
        record_id: programmeId,
        status: 'partial',
        covered_action_record_ids: [runId],
        reasons: ['Only one action has independent coverage.'],
      },
    ];
    view.pilot = projection;
    view.records = [
      {
        id: attemptId,
        programme_id: programmeId,
        programme_revision: 1,
        created_at: '2026-10-27T00:00:00Z',
        task_binding: null,
        applicability: 'programme_record',
        record: {
          kind: 'digital_action',
          action_id: 'synthetic-action',
          action_version: '3',
          permitted_action: 'Synthetic alert only',
          registration_id: null,
          rule: { id: 'alert-rule', version: '7' },
          mode: 'simulated',
          status: 'confirmed',
          action_kind: 'exposure_alert',
          occurred_at: '2026-10-27T00:00:00Z',
          scope:
            pilotTaskView().protocol!.value.specification.digital_rule!.scope,
          trigger_refs: [],
          receipt_ref: null,
          reconciles_record_id: null,
          description: 'Explicit synthetic imported test.',
        },
      },
    ];
    const html = wrapped(createElement(PilotDeliveryResults, { view }));
    expect(html).toContain('Simulation only; no live delivery');
    expect(html).toContain('alert received');
    expect(html).toContain('provider accepted');
    expect(html).toContain('schedule applied');
    expect(html).toContain('Historical event; current support withheld');
    expect(html).toContain('Provider reported failure');
    expect(html).toContain('Receipt is missing');
    expect(html).toContain('Unresolved material deviation');
    expect(html).toContain('partial');
    expect(html).toContain('version 7');
    expect(html).toContain('Action payload version 3');
    expect(html).toContain('Synthetic alert only');
    expect(html).toContain('No service receipt is attached');
    expect(html).toContain('Receipt does not establish attention or adherence');
    expect(html).toContain('executes no alert or schedule action');
  });
  it('offers current reviewed planning dependencies with gaps, without target-met filtering or automatic starts', () => {
    const view = programmeView();
    const preview = previewView();
    preview.plan!.value.state = 'evidence_gap';
    preview.assessment!.value.target_met = false;
    view.programme.pilot_input_ref = artifactRef;
    view.capacity.remaining_attempts.pilot = 3;
    view.attempts = [
      {
        attempt: programmeAttempt('planning'),
        execution_status: 'completed',
        currency: 'current',
        result_status: 'gap',
        preview,
        historical_artifact_refs: [],
        reasons: [],
      },
    ];
    const mutate = vi.fn();
    let html = wrapped(
      createElement(ProgrammePhaseStarts, { view, pending: false, mutate }),
    );
    expect(html).toContain(`value="${attemptId}"`);
    expect(html).toContain('evidence gap');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Start pilot draft from selected planning attempt<\/button>/,
    );
    expect(mutate).not.toHaveBeenCalled();
    view.attempts[0]!.preview!.plan_review!.value.verdict = 'rejected';
    html = wrapped(
      createElement(ProgrammePhaseStarts, { view, pending: false, mutate }),
    );
    expect(html).not.toContain(`value="${attemptId}"`);
  });
  it('renders explicit import/revision and bounded record controls without submitting on render', () => {
    const view = programmeView();
    const mutate = vi.fn();
    const props = { view, pending: false, mutate, onError: vi.fn() };
    const html = wrapped(
      createElement(
        'div',
        null,
        createElement(ProgrammePilotInputEditor, props),
        createElement(ProgrammePilotRecordEditor, props),
      ),
    );
    expect(html).toContain('Save pilot-input revision');
    expect(html).toContain('Load synthetic pilot-input example');
    expect(html).toContain('Explicitly clear');
    expect(html).toContain('Typed record kind');
    expect(html).toContain('maxLength="65536"');
    expect(html).toContain('Append typed record');
    expect(html).toContain('Insert editable field guide');
    expect(html).toContain('leaves required attestations blank');
    expect(html).toContain('idempotency key');
    expect(mutate).not.toHaveBeenCalled();
    expect(useAgentRun).toHaveBeenCalledWith(
      undefined,
      'haze.reduction.pilot.input',
      { restoreFromStorage: false },
    );
  });
  it('keeps per-attempt pilot output historical and renders raw typed records safely', () => {
    const view = programmeView();
    const attempt = {
      ...programmeAttempt(),
      phase: 'pilot' as const,
      planning_attempt_id: attemptId,
    };
    const html = wrapped(
      createElement(ProgrammeAttempt, {
        entry: {
          attempt,
          execution_status: 'completed',
          currency: 'historical',
          result_status: 'available',
          preview: null,
          pilot: pilotTaskView(),
          historical_artifact_refs: [artifactRef],
          reasons: [],
        },
      }),
    );
    expect(html).toContain('Bound planning attempt');
    expect(html).toContain('Retained classification');
    expect(html).not.toContain('Current classification');
    view.records = [
      {
        id: runId,
        programme_id: programmeId,
        programme_revision: 2,
        created_at: '2026-10-27T00:00:00Z',
        task_binding: null,
        applicability: 'programme_record',
        record: {
          kind: 'delivery_verification',
          registration_id: null,
          action_record_ids: [attemptId],
          verification_ref: artifactRef,
        },
      },
    ];
    const records = wrapped(createElement(ProgrammeRecords, { view }));
    expect(records).toContain('Exact typed record fields');
    expect(records).toContain('delivery_verification');
  });
});
