import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import {
  artifactSchema,
  type ArtifactRef,
} from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  pilotRegistrationRecordSchema,
  reductionPilotTaskViewSchema,
  type PilotCurrentDraft,
  type PilotInput,
  type PilotRecordBody,
  type DigitalServiceReceipt,
} from '../../app/contracts/damage-reduction-pilot.js';
import {
  reductionProgrammeViewSchema,
  reductionProgrammeMutationReceiptSchema,
  reductionProgrammeHistorySchema,
} from '../../app/contracts/damage-reduction-programme.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import {
  SYNTHETIC_REDUCTION_TARGET,
  syntheticResidualImport,
} from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import {
  createReductionSelection,
  exactReductionRef,
} from '../../app/capabilities/damage-reduction-planning/inputs.js';
import { syntheticReductionCandidate } from '../../app/capabilities/damage-reduction-planning/planning-fixtures.js';
import {
  syntheticPilotInput,
  suppliedCompletePilotInput,
  syntheticPilotRegistration,
  syntheticDigitalActionRecord,
  syntheticActionReceipt,
} from '../../app/capabilities/damage-reduction-programmes/pilot-fixtures.js';
import { ReductionProgrammeService } from '../../app/capabilities/damage-reduction-programmes/service.js';
import { projectPilotRecords } from '../../app/capabilities/damage-reduction-programmes/pilot-records.js';
import { createTaskHandler } from '../../app/tasks/http.js';
import { localTaskIdentity } from '../../app/tasks/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing local server.');
  return `http://127.0.0.1:${address.port}`;
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'haze-reduction-pilot-'));
  let handler = createTaskHandler({
    stateDirectory: directory,
    mode: 'fixture',
    registry: createExecutionRegistry({ mode: 'fixture' }),
    env: {},
  });
  let server = createServer(handler);
  let origin = await listen(server);
  async function close() {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await handler.close();
  }
  cleanups.push(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get runtime() {
      return handler.runtime;
    },
    async restart(mode: 'fixture' | 'live' = 'fixture') {
      await close();
      handler = createTaskHandler({
        stateDirectory: directory,
        mode,
        registry: createExecutionRegistry({ mode }),
        env: {},
      });
      server = createServer(handler);
      origin = await listen(server);
    },
    async call(path: string, body?: unknown, key: string = randomUUID()) {
      const response = await fetch(
        origin + path,
        body === undefined
          ? { headers: { Connection: 'close' } }
          : {
              method: 'POST',
              headers: {
                Origin: origin,
                Connection: 'close',
                'Content-Type': 'application/json',
                'Idempotency-Key': key,
              },
              body: JSON.stringify(body),
            },
      );
      return { status: response.status, body: await response.json() };
    },
  };
}
type Api = Awaited<ReturnType<typeof setup>>;
async function importJson(
  api: Api,
  content: unknown,
  label = 'pilot-engineering-evidence',
): Promise<ArtifactRef> {
  const response = await api.call('/api/artifacts', {
    schema_version: 'haze.artifact.import.v3',
    filename: `${label}.json`,
    media_type: 'application/json',
    declared_origin:
      'Explicit engineering recordkeeping fixture; no actual service was contacted.',
    content_base64: Buffer.from(JSON.stringify(content)).toString('base64'),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return exactReductionRef(artifactSchema.parse(response.body));
}
async function programme(api: Api, id: string) {
  const response = await api.call(`/api/reduction-programmes/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return reductionProgrammeViewSchema.parse(response.body);
}
async function settle(api: Api, id: string) {
  await expect
    .poll(() => api.runtime.store.read(id, localTaskIdentity).status, {
      timeout: 20_000,
    })
    .not.toMatch(/^(queued|running)$/);
  const task = api.runtime.store.read(id, localTaskIdentity);
  expect(
    task.status,
    JSON.stringify({
      error: task.error,
      assignments: task.assignments.map(
        ({ definition_id, status, error, gaps }) => ({
          definition_id,
          status,
          error,
          gaps,
        }),
      ),
    }),
  ).toBe('completed');
  return task;
}
const fence = (task: TaskRecord) => ({
  expected_objective_revision: task.objective_revision,
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_state_revision: task.state_revision,
});
async function phase(
  api: Api,
  id: string,
  kind: 'assessment' | 'planning' | 'pilot',
  dependency?: string,
) {
  const before = await programme(api, id);
  const input = {
    schema_version: 'haze.reduction.programme.phase.v1',
    expected_revision: before.programme.revision,
    phase: kind,
    ...(kind === 'planning'
      ? { assessment_attempt_id: dependency }
      : kind === 'pilot'
        ? { planning_attempt_id: dependency }
        : {}),
  };
  const response = await api.call(
    `/api/reduction-programmes/${id}/phases`,
    input,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  const attempt = reductionProgrammeMutationReceiptSchema.parse(
    response.body,
  ).attempt!;
  await settle(api, attempt.task_id);
  return attempt;
}
async function plannedProgramme(api: Api) {
  const source = await importJson(
    api,
    syntheticResidualImport(),
    'physical-residuals',
  );
  const preview = {
    schema_version: 'haze.reduction.preview-request.v1',
    selection: createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
      { artifact: source, row_ids: ['baseline-1', 'intervention-1'] },
    ]),
    candidate: syntheticReductionCandidate(),
  };
  const response = await api.call('/api/reduction-programmes', {
    schema_version: 'haze.reduction.programme.create.v1',
    expected_revision: 0,
    title: 'Synthetic pilot recordkeeping programme',
    accountable_owner: 'Fixture local operator',
    scientific_owner: null,
    preview,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const id = reductionProgrammeMutationReceiptSchema.parse(
    response.body,
  ).programme_id;
  const assessment = await phase(api, id, 'assessment');
  const planning = await phase(api, id, 'planning', assessment.id);
  return { id, source, preview, assessment, planning };
}
async function completeEngineeringInput(api: Api) {
  const evidence = await importJson(
    api,
    {
      schema_version: 'haze.reduction.pilot-fixture-evidence.v1',
      origin: 'supplied',
      statement:
        'Invented design-specific assumptions and rule approval declarations; independent scientific validity is not established.',
    },
    'synthetic-dossier',
  );
  const input = suppliedCompletePilotInput(evidence);
  input.origin = 'synthetic';
  const now = new Date().toISOString();
  input.design_review!.reviewed_at = now;
  const rule = input.protocol_spec.digital_rule!;
  rule.approval.approved_at = now;
  rule.scope.period = { start: '2026-01-01', end: '2027-12-31' };
  return input;
}
async function draftPilot(
  api: Api,
  parent: Awaited<ReturnType<typeof plannedProgramme>>,
  input: PilotInput = syntheticPilotInput(),
) {
  const inputRef = await importJson(api, input, 'pilot-scientific-inputs');
  const before = await programme(api, parent.id);
  const revised = await api.call(
    `/api/reduction-programmes/${parent.id}/revisions`,
    {
      schema_version: 'haze.reduction.programme.revise.v1',
      expected_revision: before.programme.revision,
      reason:
        'Pin exact supplied pilot feasibility and protocol inputs for an explicit bounded draft run.',
      pilot_input_ref: inputRef,
    },
  );
  expect(revised.status, JSON.stringify(revised.body)).toBe(200);
  const attempt = await phase(api, parent.id, 'pilot', parent.planning.id);
  const response = await api.call(
    `/api/tasks/${attempt.task_id}/views/reduction-pilot`,
  );
  expect(response.status).toBe(200);
  const pilot = reductionPilotTaskViewSchema.parse(response.body);
  expect(pilot.state, JSON.stringify(pilot.reasons)).toBe('current');
  expect(pilot.feasibility).not.toBeNull();
  expect(pilot.protocol).not.toBeNull();
  expect(pilot.review?.value.verdict).toBe('supported');
  const draft: PilotCurrentDraft = {
    attempt_id: attempt.id,
    feasibility: pilot.feasibility!,
    protocol: pilot.protocol!,
    review: pilot.review!,
  };
  return { ...parent, input, inputRef, attempt, pilot, draft };
}
type Scene = Awaited<ReturnType<typeof draftPilot>>;
async function append(
  api: Api,
  id: string,
  record: PilotRecordBody,
  key: string = randomUUID(),
) {
  const before = await programme(api, id);
  const input = {
    schema_version: 'haze.reduction.programme.record-request.v1',
    expected_revision: before.programme.revision,
    record,
  };
  const response = await api.call(
    `/api/reduction-programmes/${id}/records`,
    input,
    key,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const receipt = reductionProgrammeMutationReceiptSchema.parse(response.body);
  const view = await programme(api, id);
  const saved = view.records.find(
    ({ programme_revision }) => programme_revision === receipt.revision,
  )!;
  expect(saved).toBeDefined();
  return { input, receipt, saved, view, key };
}
function registration(scene: Scene) {
  return pilotRegistrationRecordSchema.parse(
    syntheticPilotRegistration(scene.draft),
  );
}
function action(
  scene: Scene,
  registrationId: string | null,
  id: string = randomUUID(),
) {
  const body = syntheticDigitalActionRecord(registrationId);
  const rule = scene.draft.protocol.value.specification.digital_rule!;
  return {
    ...body,
    action_id: id,
    occurred_at: new Date().toISOString(),
    rule: { id: rule.id, version: rule.version },
    action_kind: rule.kind,
    permitted_action: rule.permitted_actions[0]!,
    scope: structuredClone(rule.scope),
    trigger_refs: rule.trigger_inputs.flatMap(({ evidence }) => evidence),
  };
}
async function withReceipt(
  api: Api,
  body: Extract<PilotRecordBody, { kind: 'digital_action' }>,
  origin: DigitalServiceReceipt['origin'] = 'synthetic',
  level: DigitalServiceReceipt['confirmation_level'] = 'alert_transmitted',
) {
  const receipt = syntheticActionReceipt(body);
  receipt.origin = origin;
  receipt.confirmation_level = level;
  if (body.status === 'failed') {
    receipt.status = 'failed';
    receipt.confirmation_level = 'none';
  }
  if (body.status === 'unknown') {
    receipt.status = 'unknown';
    receipt.confirmation_level = 'none';
  }
  if (body.status === 'submitted') receipt.status = 'accepted';
  if (origin === 'imported_service')
    receipt.raw_receipt_ref = await importJson(
      api,
      {
        action_id: body.action_id,
        status: receipt.status,
        declaration:
          'Imported provider receipt example retained only for engineering verification.',
      },
      'raw-service-receipt',
    );
  return {
    ...body,
    receipt_ref: await importJson(api, receipt, 'service-receipt'),
  };
}
function service(api: Api) {
  const value = api.runtime.extension('reduction-programmes')?.service;
  if (!(value instanceof ReductionProgrammeService))
    throw new Error('Missing programme service.');
  return value;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'checked_at')
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

describe('pilot and digital-action recordkeeping integration', () => {
  it.each([
    'comparator',
    'baseline',
    'precision_power',
    'outcome_latency',
  ] as const)(
    'retains an explicit limited pilot when %s is unusable',
    async (topic) => {
      const api = await setup();
      const parent = await plannedProgramme(api);
      const input = await completeEngineeringInput(api);
      input.findings.find((finding) => finding.topic === topic)!.status =
        'unavailable';
      const scene = await draftPilot(api, parent, input);
      expect(scene.pilot.feasibility?.value.classification).toBe(
        'delivery_exposure_feasibility_only',
      );
      expect(
        scene.pilot.feasibility?.value.findings.find(
          (finding) => finding.topic === topic,
        )?.status,
      ).toBe('unavailable');
      expect(
        scene.pilot.feasibility?.value.prerequisites.length,
      ).toBeGreaterThan(0);
      expect(scene.pilot.scientific_qualification).toBe('unqualified');
      expect(scene.pilot.achieved_reduction).toBe(false);
      expect(scene.pilot.live_delivery).toBe('deferred');
    },
    40_000,
  );

  it('pins and independently reviews complete synthetic feasibility/protocol drafts without scientific qualification', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    expect(scene.pilot.feasibility?.value.classification).toBe('conditional');
    expect(scene.pilot.feasibility?.value.classification_basis).toBe(
      'engineering_completeness_only',
    );
    expect(scene.pilot.protocol?.value.target_sha256).toBe(
      contractHash(scene.preview.selection.target),
    );
    expect(scene.pilot.protocol?.value.input_ref).toEqual(scene.inputRef);
    expect(scene.pilot.review?.value.reviewed_artifacts).toContainEqual(
      scene.pilot.protocol!.artifact,
    );
    const task = api.runtime.store.read(
      scene.attempt.task_id,
      localTaskIdentity,
    );
    expect(
      new Set(
        task.assignments
          .filter(({ role }) => role !== 'Manager')
          .map(({ role }) => role),
      ),
    ).toEqual(new Set(['WorkerShield', 'EvidenceCritic']));
    expect(task.usage.tool_calls).toBeLessThanOrEqual(40);
    expect(task.usage.artifacts).toBeLessThanOrEqual(64);
    const view = await programme(api, scene.id);
    expect(view.capacity.remaining_attempts.pilot).toBe(2);
    expect(view.capacity.remaining_runs).toBe(9);
    expect(view.pilot?.feasibility?.current).toBe(true);
    const unbound = api.runtime.admit(
      structuredClone(task.original_request),
      'standalone-pilot-copy',
      localTaskIdentity,
    );
    await settle(api, unbound.task_id);
    const unboundView = reductionPilotTaskViewSchema.parse(
      (await api.call(`/api/tasks/${unbound.task_id}/views/reduction-pilot`))
        .body,
    );
    expect(unboundView.review?.value.verdict).toBe('supported');
    const unboundDraft: PilotCurrentDraft = {
      attempt_id: randomUUID(),
      feasibility: unboundView.feasibility!,
      protocol: unboundView.protocol!,
      review: unboundView.review!,
    };
    const adoption = await api.call(
      `/api/reduction-programmes/${scene.id}/records`,
      {
        schema_version: 'haze.reduction.programme.record-request.v1',
        expected_revision: view.programme.revision,
        record: syntheticPilotRegistration(unboundDraft),
      },
    );
    expect(adoption.status, JSON.stringify(adoption.body)).toBe(409);
    expect(adoption.body).toMatchObject({
      error: { code: 'programme_pilot_attempt_required' },
    });
    const after = await programme(api, scene.id);
    expect(after.programme.revision).toBe(view.programme.revision);
    expect(after.attempts).toHaveLength(view.attempts.length);
    expect(after.capacity).toEqual(view.capacity);
  }, 40_000);

  it('uses server retention time and preserves late/unknown outcome access despite an earlier external registration date', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    const unknown = registration(scene);
    unknown.outcome_access.collection = 'unknown';
    unknown.outcome_access.analysis = 'unknown';
    const uncertain = await append(api, scene.id, unknown);
    expect(
      uncertain.view.pilot?.registrations.find(
        ({ record_id }) => record_id === uncertain.saved.id,
      )?.timing,
    ).toBe('unknown');
    const before = Date.now();
    const late = registration(scene);
    late.outcome_access.collection = 'complete';
    late.outcome_access.analysis = 'started';
    late.outcome_access.collection_started_at = '2026-01-01T00:00:00Z';
    late.outcome_access.analysis_started_at = '2026-01-02T00:00:00Z';
    const external = await importJson(
      api,
      {
        schema_version: 'haze.reduction.external-registration.v1',
        origin: 'synthetic',
        registry: 'Synthetic earlier registry attestation',
        registered_at: '2020-01-01T00:00:00Z',
        protocol_sha256: scene.draft.protocol.artifact.sha256,
        evidence: [],
      },
      'external-registration',
    );
    late.external_registration = {
      registered_at: '2020-01-01T00:00:00Z',
      evidence: external,
      registry: 'Synthetic earlier registry attestation',
    };
    const saved = await append(api, scene.id, late);
    const projected = saved.view.pilot!.registrations.find(
      ({ record_id }) => record_id === saved.saved.id,
    )!;
    expect(projected.timing).toBe('late_or_outcome_aware');
    expect(Date.parse(projected.recorded_at)).toBeGreaterThanOrEqual(before);
    expect(projected.recorded_at).not.toBe('2020-01-01T00:00:00Z');
    const cannotReset = await append(api, scene.id, registration(scene));
    expect(
      cannotReset.view.pilot?.registrations.find(
        ({ record_id }) => record_id === cannotReset.saved.id,
      )?.timing,
    ).toBe('late_or_outcome_aware');
  }, 40_000);

  it('retains idempotent registration originals and marks an outcome-aware amendment exploratory', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    const original = await append(
      api,
      scene.id,
      registration(scene),
      'pilot-registration',
    );
    const duplicate = await api.call(
      `/api/reduction-programmes/${scene.id}/records`,
      original.input,
      original.key,
    );
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual(original.receipt);
    const amendedInput = structuredClone(scene.input);
    amendedInput.protocol_spec.version = '2';
    amendedInput.protocol_spec.analysis_method!.description =
      'Outcome-aware revised external analysis retained as exploratory engineering content.';
    const amendedDraft = await draftPilot(api, scene, amendedInput);
    const amendment = await append(api, scene.id, {
      kind: 'pilot_amendment',
      registration_id: original.saved.id,
      amended_protocol_ref: amendedDraft.draft.protocol.artifact,
      review_ref: amendedDraft.draft.review.artifact,
      reason:
        'Outcome-aware analysis handling is exploratory; preserve the original registered analysis.',
      affected_fields: ['analysis'],
      outcomes_available: 'yes',
      attested_by: 'Fixture operator',
      attested_at: new Date().toISOString(),
    });
    expect(
      amendment.view.pilot?.amendments.find(
        ({ record_id }) => record_id === amendment.saved.id,
      )?.status,
    ).toBe('exploratory');
    expect(
      amendment.view.records.find(({ id }) => id === original.saved.id),
    ).toEqual(original.saved);
    expect(
      api.runtime.store.artifact(
        scene.draft.protocol.artifact.id,
        localTaskIdentity,
      ).sha256,
    ).toBe(scene.draft.protocol.artifact.sha256);
    const historicalReplay = await api.call(
      `/api/reduction-programmes/${scene.id}/records`,
      original.input,
      original.key,
    );
    expect(historicalReplay.status).toBe(200);
    expect(historicalReplay.body).toEqual(original.receipt);
  }, 40_000);

  it('never promotes simulated actions or human reports to service-confirmed delivery', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    const registered = await append(api, scene.id, registration(scene));
    const simulation = await withReceipt(
      api,
      { ...action(scene, registered.saved.id), status: 'confirmed' },
      'synthetic',
    );
    const simulated = await append(api, scene.id, simulation);
    const simulatedView = simulated.view.pilot!.actions.find(
      ({ record_id }) => record_id === simulated.saved.id,
    )!;
    expect(simulatedView.origin).toBe('simulated');
    expect(simulatedView.effective_status).toBe('simulated');
    expect(simulatedView.recorded_delivery).toBe(false);
    const human = await withReceipt(
      api,
      {
        ...action(scene, registered.saved.id),
        mode: 'imported_live',
        status: 'unknown',
      },
      'human_report',
    );
    const report = await append(api, scene.id, human);
    const reported = report.view.pilot!.actions.find(
      ({ record_id }) => record_id === report.saved.id,
    )!;
    expect(reported.origin).toBe('human_report');
    expect(reported.recorded_delivery).toBe(false);
    expect(report.view.pilot?.live_delivery).toBe('deferred');
    expect(report.view.pilot?.achieved_reduction).toBe(false);
  }, 40_000);

  it('retains unknown/failure history, withholds replay support and appends exact reconciliation evidence without an agent run', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    const registered = await append(api, scene.id, registration(scene));
    const before = await programme(api, scene.id);
    const accepted = await append(
      api,
      scene.id,
      await withReceipt(
        api,
        {
          ...action(scene, registered.saved.id, 'provider-accepted-only'),
          mode: 'imported_live',
          status: 'submitted',
        },
        'imported_service',
        'provider_accepted',
      ),
    );
    expect(
      accepted.view.pilot!.actions.find(
        ({ record_id }) => record_id === accepted.saved.id,
      )?.effective_status,
    ).toBe('submitted');
    expect(
      accepted.view.pilot!.actions.find(
        ({ record_id }) => record_id === accepted.saved.id,
      )?.recorded_delivery,
    ).toBe(false);
    const unknownBody = {
      ...action(scene, registered.saved.id, 'unknown-action'),
      mode: 'imported_live' as const,
      status: 'unknown' as const,
    };
    const unknown = await append(
      api,
      scene.id,
      unknownBody,
      'unknown-action-event',
    );
    expect(
      unknown.view.pilot?.actions.find(
        ({ record_id }) => record_id === unknown.saved.id,
      )?.effective_status,
    ).toBe('unknown');
    const retry = await api.call(
      `/api/reduction-programmes/${scene.id}/records`,
      unknown.input,
      unknown.key,
    );
    expect(retry.body).toEqual(unknown.receipt);
    const replay = await api.call(
      `/api/reduction-programmes/${scene.id}/records`,
      {
        schema_version: 'haze.reduction.programme.record-request.v1',
        expected_revision: unknown.view.programme.revision,
        record: unknownBody,
      },
    );
    expect(replay.status).toBe(200);
    const replayReceipt = reductionProgrammeMutationReceiptSchema.parse(
      replay.body,
    );
    const replayView = await programme(api, scene.id);
    const replayRecord = replayView.records.find(
      ({ programme_revision }) => programme_revision === replayReceipt.revision,
    )!;
    expect(
      replayView.pilot!.actions.find(
        ({ record_id }) => record_id === replayRecord.id,
      )?.recorded_delivery,
    ).toBe(false);
    expect(
      replayView.pilot!.actions.find(
        ({ record_id }) => record_id === replayRecord.id,
      )?.effective_status,
    ).toBe('unknown');
    const reconciledBody = await withReceipt(
      api,
      {
        ...unknownBody,
        status: 'confirmed',
        reconciles_record_id: unknown.saved.id,
      },
      'imported_service',
    );
    const reconciled = await append(api, scene.id, reconciledBody);
    const confirmation = reconciled.view.pilot!.actions.find(
      ({ record_id }) => record_id === reconciled.saved.id,
    )!;
    expect(confirmation.origin).toBe('imported_service');
    expect(confirmation.effective_status).toBe('confirmed');
    expect(confirmation.recorded_delivery).toBe(true);
    expect(
      reconciled.view.records.find(({ id }) => id === unknown.saved.id)?.record,
    ).toEqual(unknownBody);
    const failedBody = await withReceipt(
      api,
      {
        ...action(scene, registered.saved.id, 'failed-action'),
        mode: 'imported_live',
        status: 'failed',
      },
      'imported_service',
      'none',
    );
    const failed = await append(api, scene.id, failedBody);
    expect(
      failed.view.pilot?.actions.find(
        ({ record_id }) => record_id === failed.saved.id,
      )?.effective_status,
    ).toBe('failed');
    expect(
      failed.view.pilot?.actions.find(
        ({ record_id }) => record_id === failed.saved.id,
      )?.recorded_delivery,
    ).toBe(false);
    expect(failed.view.attempts).toHaveLength(before.attempts.length);
    expect(failed.view.capacity.charged_tool_calls).toBe(
      before.capacity.charged_tool_calls,
    );
    expect(failed.view.pilot?.live_delivery).toBe('deferred');
    expect(failed.view.pilot?.achieved_reduction).toBe(false);
  }, 40_000);

  it('withholds delivery support for receipt conflicts and actions outside the registered rule/scope', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    const registered = await append(api, scene.id, registration(scene));
    const mismatched = {
      ...action(scene, registered.saved.id, 'mismatched-receipt'),
      mode: 'imported_live' as const,
      status: 'confirmed' as const,
    };
    const wrongReceipt = syntheticActionReceipt(mismatched);
    wrongReceipt.action_id = 'different-action';
    wrongReceipt.origin = 'imported_service';
    mismatched.receipt_ref = await importJson(
      api,
      wrongReceipt,
      'conflicting-receipt',
    );
    const wrongVersion = {
      ...action(scene, registered.saved.id, 'wrong-action-version'),
      mode: 'imported_live' as const,
      status: 'confirmed' as const,
    };
    const versionReceipt = syntheticActionReceipt(wrongVersion);
    versionReceipt.origin = 'imported_service';
    versionReceipt.action_version = 'unexpected-action-version';
    wrongVersion.receipt_ref = await importJson(
      api,
      versionReceipt,
      'conflicting-action-version',
    );
    const candidates = [
      mismatched,
      wrongVersion,
      await withReceipt(
        api,
        {
          ...action(scene, registered.saved.id, 'unapproved-action'),
          mode: 'imported_live',
          status: 'confirmed',
          permitted_action: 'An action that the agreed rule never permits.',
        },
        'imported_service',
      ),
      await withReceipt(
        api,
        {
          ...action(scene, registered.saved.id, 'wrong-rule-version'),
          mode: 'imported_live',
          status: 'confirmed',
          rule: { id: mismatched.rule.id, version: 'unregistered-version' },
        },
        'imported_service',
      ),
      await withReceipt(
        api,
        {
          ...action(scene, registered.saved.id, 'out-of-scope'),
          mode: 'imported_live',
          status: 'confirmed',
          scope: {
            ...mismatched.scope,
            geography: 'Different operating geography',
          },
        },
        'imported_service',
      ),
    ];
    for (const record of candidates) {
      const before = await programme(api, scene.id);
      const response = await api.call(
        `/api/reduction-programmes/${scene.id}/records`,
        {
          schema_version: 'haze.reduction.programme.record-request.v1',
          expected_revision: before.programme.revision,
          record,
        },
      );
      const after = await programme(api, scene.id);
      if (response.status === 200) {
        const receipt = reductionProgrammeMutationReceiptSchema.parse(
          response.body,
        );
        const saved = after.records.find(
          ({ programme_revision }) => programme_revision === receipt.revision,
        )!;
        const projected = after.pilot!.actions.find(
          ({ record_id }) => record_id === saved.id,
        )!;
        expect(projected.recorded_delivery).toBe(false);
        expect(projected.reasons.length).toBeGreaterThan(0);
      } else {
        expect([400, 409, 422]).toContain(response.status);
        expect(after.programme.revision).toBe(before.programme.revision);
        expect(after.records).toHaveLength(before.records.length);
      }
    }
  }, 40_000);

  it('retains partial independent verification and material deviations without claiming all delivery or reduced damage', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    const registered = await append(api, scene.id, registration(scene));
    const firstBody = await withReceipt(
      api,
      {
        ...action(scene, registered.saved.id, 'verified-subset-action'),
        mode: 'imported_live',
        status: 'confirmed',
      },
      'imported_service',
    );
    const secondBody = await withReceipt(
      api,
      {
        ...action(scene, registered.saved.id, 'unverified-action'),
        mode: 'imported_live',
        status: 'confirmed',
      },
      'imported_service',
    );
    const first = await append(api, scene.id, firstBody);
    const second = await append(api, scene.id, secondBody);
    const verificationRef = await importJson(
      api,
      {
        schema_version: 'haze.reduction.delivery-verification.v1',
        origin: 'supplied',
        verifier: {
          name: 'Fixture independent delivery reviewer',
          role: 'Independent retained attestation; not credential verification',
          independent: true,
          conflicts: 'none_declared',
          attested_at: new Date().toISOString(),
        },
        actions: [
          {
            record_id: first.saved.id,
            action_id: firstBody.action_id,
            action_version: firstBody.action_version,
            permitted_action: firstBody.permitted_action,
            trigger_refs: firstBody.trigger_refs,
            rule: firstBody.rule,
            scope: firstBody.scope,
            verdict: 'verified',
            confirmation_level: 'alert_transmitted',
            evidence: [firstBody.receipt_ref],
          },
        ],
        limitations: [
          'Engineering example covers one exact recorded action only.',
        ],
      },
      'partial-delivery-verification',
    );
    const verified = await append(api, scene.id, {
      kind: 'delivery_verification',
      registration_id: registered.saved.id,
      action_record_ids: [first.saved.id, second.saved.id],
      verification_ref: verificationRef,
    });
    const coverage = verified.view.pilot!.verifications.find(
      ({ record_id }) => record_id === verified.saved.id,
    )!;
    expect(coverage.status).toBe('partial');
    expect(coverage.covered_action_record_ids).toContain(first.saved.id);
    expect(coverage.covered_action_record_ids).not.toContain(second.saved.id);
    expect(
      verified.view.pilot?.actions.find(
        ({ record_id }) => record_id === second.saved.id,
      )?.independent_verification,
    ).toBe('none');
    const deviation = await append(api, scene.id, {
      kind: 'pilot_deviation',
      registration_id: registered.saved.id,
      action_record_ids: [second.saved.id],
      category: 'operating-constraint',
      description:
        'A material service operating departure remains unresolved in this fixture.',
      material: true,
      status: 'open',
      occurred_at: new Date().toISOString(),
      evidence: [secondBody.receipt_ref],
      resolves_deviation_id: null,
    });
    expect(
      deviation.view.pilot?.deviations.find(
        ({ record_id }) => record_id === deviation.saved.id,
      ),
    ).toMatchObject({ material: true, unresolved: true });
    expect(deviation.view.pilot?.scientific_qualification).toBe('unqualified');
    expect(deviation.view.pilot?.achieved_reduction).toBe(false);
  }, 40_000);

  it('retains truthful delivery gaps without a registered protocol and prevents pilot admission without selected input', async () => {
    const api = await setup();
    const parent = await plannedProgramme(api);
    const before = await programme(api, parent.id);
    const missing = await api.call(
      `/api/reduction-programmes/${parent.id}/phases`,
      {
        schema_version: 'haze.reduction.programme.phase.v1',
        expected_revision: before.programme.revision,
        phase: 'pilot',
        planning_attempt_id: parent.planning.id,
      },
    );
    expect([409, 422]).toContain(missing.status);
    const unregistered = syntheticDigitalActionRecord(null);
    unregistered.action_id = 'unknown-unregistered-action';
    unregistered.mode = 'imported_live';
    unregistered.status = 'unknown';
    unregistered.occurred_at = new Date().toISOString();
    unregistered.scope.period = { start: '2026-01-01', end: '2027-12-31' };
    const retained = await append(api, parent.id, unregistered);
    const projected = retained.view.pilot!.actions.find(
      ({ record_id }) => record_id === retained.saved.id,
    )!;
    expect(projected.recorded_delivery).toBe(false);
    expect(projected.reasons.length).toBeGreaterThan(0);
    expect(retained.view.attempts).toHaveLength(2);
    expect(retained.view.capacity.charged_tool_calls).toBe(
      before.capacity.charged_tool_calls,
    );
  }, 40_000);

  it('rechecks pilot source holds/revocations and retains exact record history after restart', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    const registered = await append(api, scene.id, registration(scene));
    const simulated = await append(
      api,
      scene.id,
      await withReceipt(api, {
        ...action(scene, registered.saved.id, 'restart-simulation'),
        status: 'confirmed',
      }),
    );
    const historyResponse = await api.call(
      `/api/reduction-programmes/${scene.id}/history`,
    );
    const beforeHistory = reductionProgrammeHistorySchema.parse(
      historyResponse.body,
    );
    await api.restart();
    expect(stable(await programme(api, scene.id))).toEqual(
      stable(simulated.view),
    );
    expect(
      reductionProgrammeHistorySchema.parse(
        (await api.call(`/api/reduction-programmes/${scene.id}/history`)).body,
      ),
    ).toEqual(beforeHistory);
    const scope = { ...localTaskIdentity, mode: 'fixture' as const };
    const sourceRecord = api.runtime.store.world.lookup(scope, {
      kind: 'artifact_reference',
      external_id: `artifact:${scene.inputRef.id}:${scene.inputRef.version}`,
      limit: 2,
    })[0]!;
    const hold = api.runtime.store.world.hold(
      scope,
      sourceRecord.ref,
      'Pilot scientific input has been held for renewed applicability review.',
      'unknown_impact',
    );
    const held = await programme(api, scene.id);
    expect(held.programme.revision).toBe(simulated.view.programme.revision);
    expect(held.pilot?.feasibility?.current).not.toBe(true);
    expect(
      held.pilot?.registrations.find(
        ({ record_id }) => record_id === registered.saved.id,
      )?.currency,
    ).toBe('stale');
    api.runtime.store.world.clearHold(
      scope,
      hold.id,
      'Exact pilot source reinstated by the local operator.',
    );
    const task = api.runtime.store.read(
      scene.attempt.task_id,
      localTaskIdentity,
    );
    const draftTool = task.assignments
      .find(({ role }) => role === 'WorkerShield')!
      .tools.find((id) => id.includes('pilot'))!;
    api.runtime.control(
      task.id,
      {
        schema_version: 'haze.task.control.v3',
        ...fence(task),
        action: 'revoke',
        revoked_tools: [draftTool],
      },
      'revoke-pilot-method',
    );
    const revoked = await programme(api, scene.id);
    expect(
      revoked.pilot?.registrations.find(
        ({ record_id }) => record_id === registered.saved.id,
      )?.currency,
    ).toBe('stale');
    expect(revoked.pilot?.live_delivery).toBe('deferred');
    expect(revoked.pilot?.achieved_reduction).toBe(false);
    expect(
      revoked.records.find(({ id }) => id === registered.saved.id),
    ).toEqual(registered.saved);
  }, 40_000);

  it('rolls back typed records atomically and isolates registration access by identity and mode', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    const before = await programme(api, scene.id);
    const record = registration(scene);
    const body = {
      schema_version: 'haze.reduction.programme.record-request.v1',
      expected_revision: before.programme.revision,
      record,
    };
    expect(() =>
      api.runtime.store.transaction(() => {
        service(api).appendRecord(
          scene.id,
          body,
          'rollback-registration',
          localTaskIdentity,
        );
        throw new Error('Injected pilot-record rollback.');
      }),
    ).toThrow('Injected pilot-record rollback');
    expect((await programme(api, scene.id)).records).toHaveLength(0);
    expect((await programme(api, scene.id)).programme.revision).toBe(
      before.programme.revision,
    );
    expect(() =>
      service(api).appendRecord(scene.id, body, randomUUID(), {
        ...localTaskIdentity,
        principal: 'another-principal',
      }),
    ).toThrow();
    await append(api, scene.id, record, 'rollback-registration');
    await api.restart('live');
    expect(
      (await api.call(`/api/reduction-programmes/${scene.id}`)).status,
    ).toBe(404);
    await api.restart('fixture');
    expect((await programme(api, scene.id)).records).toHaveLength(1);
  }, 40_000);

  it('fails closed for synthetic proof wrappers and commits no partial verification state after invalid timing or a later missing proof', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    const registered = await append(api, scene.id, registration(scene));
    const rawSynthetic = await importJson(
      api,
      { origin: 'synthetic', statement: 'Synthetic raw transmission example.' },
      'synthetic-raw-receipt',
    );
    const wrappedBody = {
      ...action(scene, registered.saved.id, 'synthetic-raw-wrapper'),
      mode: 'imported_live' as const,
      status: 'confirmed' as const,
    };
    const wrapped = syntheticActionReceipt(wrappedBody);
    wrapped.origin = 'imported_service';
    wrapped.raw_receipt_ref = rawSynthetic;
    const wrapper = await append(api, scene.id, {
      ...wrappedBody,
      receipt_ref: await importJson(api, wrapped, 'supplied-receipt-wrapper'),
    });
    const wrapperView = wrapper.view.pilot!.actions.find(
      ({ record_id }) => record_id === wrapper.saved.id,
    )!;
    expect(wrapperView.origin).toBe('simulated');
    expect(wrapperView.recorded_delivery).toBe(false);
    const pairs = [];
    for (const id of [
      'first-verification-action',
      'second-verification-action',
    ]) {
      const body = await withReceipt(
        api,
        {
          ...action(scene, registered.saved.id, id),
          mode: 'imported_live',
          status: 'confirmed',
        },
        'imported_service',
      );
      const saved = await append(api, scene.id, body);
      expect(
        saved.view.pilot!.actions.find(
          ({ record_id }) => record_id === saved.saved.id,
        )?.recorded_delivery,
      ).toBe(true);
      pairs.push({ body, saved: saved.saved });
    }
    for (const variant of ['future', 'before-action', 'missing-later-proof']) {
      const verification = {
        schema_version: 'haze.reduction.delivery-verification.v1',
        origin: 'supplied',
        verifier: {
          name: 'Independent engineering verifier',
          role: 'Fixture reviewer',
          independent: true,
          conflicts: 'none_declared',
          attested_at:
            variant === 'future'
              ? new Date(Date.now() + 60_000).toISOString()
              : variant === 'before-action'
                ? '2020-01-01T00:00:00Z'
                : new Date().toISOString(),
        },
        actions: pairs.map(({ body, saved }, index) => ({
          record_id: saved.id,
          action_id: body.action_id,
          action_version: body.action_version,
          permitted_action: body.permitted_action,
          trigger_refs: body.trigger_refs,
          rule: body.rule,
          scope: body.scope,
          verdict: 'verified',
          confirmation_level: 'alert_transmitted',
          evidence:
            variant === 'missing-later-proof' && index === 1
              ? [{ id: randomUUID(), version: 1, sha256: '0'.repeat(64) }]
              : [body.receipt_ref],
        })),
        limitations: [
          'Invalid engineering verification must not publish partial successful state.',
        ],
      };
      const saved = await append(api, scene.id, {
        kind: 'delivery_verification',
        registration_id: registered.saved.id,
        action_record_ids: pairs.map(({ saved }) => saved.id),
        verification_ref: await importJson(
          api,
          verification,
          `invalid-verification-${variant}`,
        ),
      });
      const projected = saved.view.pilot!.verifications.find(
        ({ record_id }) => record_id === saved.saved.id,
      )!;
      expect(['unsupported', 'stale']).toContain(projected.status);
      expect(projected.covered_action_record_ids).toEqual([]);
      for (const pair of pairs)
        expect(
          saved.view.pilot!.actions.find(
            ({ record_id }) => record_id === pair.saved.id,
          )?.independent_verification,
        ).toBe('none');
    }
    const external = await importJson(
      api,
      {
        schema_version: 'haze.reduction.external-registration.v1',
        origin: 'supplied',
        registry: 'Example supplied registry',
        registered_at: '2020-01-01T00:00:00Z',
        protocol_sha256: scene.draft.protocol.artifact.sha256,
        evidence: [],
      },
      'external-wrapper',
    );
    const externalBody = registration(scene);
    externalBody.external_registration = {
      registry: 'Example supplied registry',
      registered_at: '2020-01-01T00:00:00Z',
      evidence: external,
    };
    const externalSaved = await append(api, scene.id, externalBody);
    expect(
      externalSaved.view.pilot!.registrations.find(
        ({ record_id }) => record_id === externalSaved.saved.id,
      )?.timing,
    ).toBe('external_prior_registration_attested');
    const syntheticMetadata = projectPilotRecords(
      externalSaved.view.programme,
      externalSaved.view.records,
      {
        identity: localTaskIdentity,
        now: new Date().toISOString(),
        current_draft: scene.draft,
        readArtifact(ref) {
          const artifact = api.runtime.store.artifact(
            ref.id,
            localTaskIdentity,
          );
          return ref.id === external.id
            ? { ...artifact, evidence_origin: 'synthetic_fixture' }
            : artifact;
        },
        assertEvidenceCurrent() {},
      },
    );
    expect(
      syntheticMetadata.registrations.find(
        ({ record_id }) => record_id === externalSaved.saved.id,
      )?.timing,
    ).not.toBe('external_prior_registration_attested');
    const ruleRef =
      scene.input.protocol_spec.digital_rule!.approval.evidence[0]!;
    const syntheticRule = projectPilotRecords(
      externalSaved.view.programme,
      externalSaved.view.records,
      {
        identity: localTaskIdentity,
        now: new Date().toISOString(),
        current_draft: scene.draft,
        readArtifact(ref) {
          const artifact = api.runtime.store.artifact(
            ref.id,
            localTaskIdentity,
          );
          return ref.id === ruleRef.id
            ? { ...artifact, evidence_origin: 'synthetic_fixture' }
            : artifact;
        },
        assertEvidenceCurrent() {},
      },
    );
    for (const pair of pairs) {
      const projected = syntheticRule.actions.find(
        ({ record_id }) => record_id === pair.saved.id,
      )!;
      expect(projected.origin).toBe('simulated');
      expect(projected.recorded_delivery).toBe(false);
      expect(projected.independent_verification).toBe('none');
    }
  }, 40_000);

  it('keeps outcome access latched across a held old review and explicit replacement target/protocol runs', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    const body = registration(scene);
    body.outcome_access.collection = 'complete';
    body.outcome_access.analysis = 'started';
    body.outcome_access.collection_started_at = '2026-01-01T00:00:00Z';
    body.outcome_access.analysis_started_at = '2026-01-02T00:00:00Z';
    const registered = await append(api, scene.id, body);
    const before = await programme(api, scene.id);
    const worldScope = { ...localTaskIdentity, mode: 'fixture' as const };
    const reviewRecord = api.runtime.store.world.lookup(worldScope, {
      kind: 'artifact_reference',
      external_id: `artifact:${scene.draft.review.artifact.id}:${scene.draft.review.artifact.version}`,
      limit: 2,
    })[0]!;
    api.runtime.store.world.hold(
      worldScope,
      reviewRecord.ref,
      'Original pilot review is held; retained outcome access must still govern later registration.',
      'unknown_impact',
    );
    const changed = structuredClone(scene.preview);
    changed.selection = createReductionSelection(
      { ...changed.selection.target, target_fraction: '0.05' },
      changed.selection.sources,
    );
    const response = await api.call(
      `/api/reduction-programmes/${scene.id}/revisions`,
      {
        schema_version: 'haze.reduction.programme.revise.v1',
        expected_revision: before.programme.revision,
        reason:
          'Retain an explicitly outcome-aware target correction without changing the original registration.',
        preview: changed,
      },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await programme(api, scene.id);
    const projected = after.pilot!.registrations.find(
      ({ record_id }) => record_id === registered.saved.id,
    )!;
    expect(projected.currency).toBe('stale');
    expect(projected.reasons.length).toBeGreaterThan(0);
    expect(after.records.find(({ id }) => id === registered.saved.id)).toEqual(
      registered.saved,
    );
    expect(after.attempts).toHaveLength(before.attempts.length);
    expect(after.capacity.charged_tool_calls).toBe(
      before.capacity.charged_tool_calls,
    );
    expect(
      api.runtime.store.artifact(
        scene.draft.protocol.artifact.id,
        localTaskIdentity,
      ).content,
    ).toEqual(scene.draft.protocol.value);
    expect(after.scientific_qualification).toBe('unqualified');
    expect(after.achieved_reduction).toBe(false);
    const assessment = await phase(api, scene.id, 'assessment');
    const planning = await phase(api, scene.id, 'planning', assessment.id);
    const input = structuredClone(scene.input);
    input.protocol_spec.version = '2';
    input.protocol_spec.target_rule!.fraction = '0.05';
    const replacement = await draftPilot(
      api,
      { ...scene, preview: changed, assessment, planning },
      input,
    );
    const newRegistration = await append(
      api,
      scene.id,
      registration(replacement),
    );
    expect(
      newRegistration.view.pilot!.registrations.find(
        ({ record_id }) => record_id === newRegistration.saved.id,
      )?.timing,
    ).toBe('late_or_outcome_aware');
    expect(
      newRegistration.view.records.find(({ id }) => id === registered.saved.id),
    ).toEqual(registered.saved);
    expect(newRegistration.view.achieved_reduction).toBe(false);
  }, 60_000);

  it('counts pilot continuations against the shared phase budget and blocks direct task mutation bypasses', async () => {
    const api = await setup();
    const scene = await draftPilot(
      api,
      await plannedProgramme(api),
      await completeEngineeringInput(api),
    );
    const original = api.runtime.store.read(
      scene.attempt.task_id,
      localTaskIdentity,
    );
    const direct = await api.call(`/api/tasks/${original.id}/control`, {
      schema_version: 'haze.task.control.v3',
      ...fence(original),
      action: 'continue',
    });
    expect([403, 409]).toContain(direct.status);
    expect(
      api.runtime.store.read(original.id, localTaskIdentity).current_run_id,
    ).toBe(original.current_run_id);
    const update = await api.call(`/api/tasks/${original.id}/updates`, {
      schema_version: 'haze.task.update.v3',
      ...fence(original),
      kind: 'correction',
      passage: 'Try to alter pilot execution outside programme admission.',
      scope: original.original_request.scope,
      affected_assignment_ids: original.assignments
        .filter(({ role }) => role !== 'Manager')
        .map(({ id }) => id),
    });
    expect([403, 409]).toContain(update.status);
    for (let index = 0; index < 2; index++) {
      const current = api.runtime.store.read(original.id, localTaskIdentity);
      const before = await programme(api, scene.id);
      const response = await api.call(`/api/tasks/${original.id}/control`, {
        schema_version: 'haze.task.control.v3',
        ...fence(current),
        action: 'continue',
        coordination: {
          owner_id: scene.id,
          expected_revision: before.programme.revision,
        },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      await settle(api, original.id);
    }
    const exhausted = await programme(api, scene.id);
    expect(exhausted.capacity.remaining_attempts.pilot).toBe(0);
    expect(
      exhausted.attempts.filter(({ attempt }) => attempt.phase === 'pilot'),
    ).toHaveLength(3);
    const task = api.runtime.store.read(original.id, localTaskIdentity);
    const denied = await api.call(`/api/tasks/${original.id}/control`, {
      schema_version: 'haze.task.control.v3',
      ...fence(task),
      action: 'continue',
      coordination: {
        owner_id: scene.id,
        expected_revision: exhausted.programme.revision,
      },
    });
    expect([409, 422]).toContain(denied.status);
    expect(
      api.runtime.store.read(original.id, localTaskIdentity).current_run_id,
    ).toBe(task.current_run_id);
    expect((await programme(api, scene.id)).programme.revision).toBe(
      exhausted.programme.revision,
    );
  }, 60_000);
});
