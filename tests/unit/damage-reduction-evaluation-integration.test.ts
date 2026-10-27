import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import {
  artifactSchema,
  type Artifact,
} from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  type EvaluationMethodContext,
  type ExternalEvaluationInput,
  evaluationTaskViewSchema,
  type EvaluationRecordBody,
  externalEvaluationInputSchema,
} from '../../app/contracts/damage-reduction-evaluation.js';
import {
  reductionProgrammeHistorySchema,
  reductionProgrammeMutationReceiptSchema,
  reductionProgrammeViewSchema,
} from '../../app/contracts/damage-reduction-programme.js';
import {
  pilotRegistrationRecordSchema,
  reductionPilotTaskViewSchema,
  type PilotCurrentDraft,
  type PilotRecordBody,
} from '../../app/contracts/damage-reduction-pilot.js';
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
  suppliedCompletePilotInput,
  syntheticPilotRegistration,
  syntheticDigitalActionRecord,
  syntheticActionReceipt,
} from '../../app/capabilities/damage-reduction-programmes/pilot-fixtures.js';
import {
  syntheticExternalEvaluationInput,
  syntheticEvaluationExpectedOutput,
  syntheticQualificationDossier,
  evaluationFixtureContext,
} from '../../app/capabilities/damage-reduction-programmes/evaluation-fixtures.js';
import {
  draftExternalEvaluation,
  independentlyReviewExternalEvaluation,
} from '../../app/capabilities/damage-reduction-programmes/evaluation-methods.js';
import { ReductionProgrammeService } from '../../app/capabilities/damage-reduction-programmes/service.js';
import { createTaskHandler } from '../../app/tasks/http.js';
import { localTaskIdentity } from '../../app/tasks/runtime.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';

const original = (content: unknown, kind = 'user-import'): Artifact =>
  artifactSchema.parse({
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: contractHash(content),
    identity: localTaskIdentity,
    producer: { kind: 'user', id: 'fixture-engineering-author' },
    kind,
    created_at: '2026-10-01T00:00:00Z',
    dependencies: [],
    evidence_origin: 'synthetic_fixture',
    content,
  });
function numericalFixture(
  baseline: string | null = '1000',
  intervention: string | null = '880',
  expectedTarget: boolean | null = true,
  relation: 'at_least' | 'greater_than' = 'at_least',
) {
  const target = { ...SYNTHETIC_REDUCTION_TARGET, relation };
  const evidence = [
    original({
      origin: 'synthetic',
      statement: 'Original invented external comparative report.',
    }),
    original({
      origin: 'synthetic',
      statement: 'Original invented comparative data.',
    }),
    original({
      origin: 'synthetic',
      statement: 'Separate external scientific-review engineering example.',
    }),
  ];
  const programmeId = randomUUID(),
    targetHash = contractHash(target),
    scopeHash = contractHash(SYNTHETIC_REDUCTION_TARGET.scope);
  const specification = suppliedCompletePilotInput(
    exactReductionRef(evidence[0]!),
  ).protocol_spec;
  specification.target_rule!.relation = relation;
  const protocol = original(
    {
      schema_version: 'haze.reduction.pilot-protocol.v1',
      programme_id: programmeId,
      input_ref: exactReductionRef(evidence[0]!),
      selection_ref: exactReductionRef(evidence[0]!),
      assessment_ref: exactReductionRef(evidence[0]!),
      plan_ref: exactReductionRef(evidence[0]!),
      plan_review_ref: exactReductionRef(evidence[0]!),
      target_sha256: targetHash,
      scope_sha256: scopeHash,
      origin: 'synthetic',
      status: 'draft',
      specification,
      prerequisites: [],
      limitations: [
        'Pure engineering protocol fixture; not a qualified reference trace.',
      ],
      scientific_qualification: 'unqualified',
      achieved_reduction: false,
    },
    'reduction.pilot-protocol',
  );
  const input = syntheticExternalEvaluationInput({
    programme_id: programmeId,
    target_sha256: targetHash,
    scope_sha256: scopeHash,
    scope: SYNTHETIC_REDUCTION_TARGET.scope,
    registration_id: randomUUID(),
    protocol_ref: exactReductionRef(protocol),
    action_record_ids: [randomUUID()],
    rules: [{ id: 'synthetic-alert-rule', version: '1' }],
    report_ref: exactReductionRef(evidence[0]!),
    data_ref: exactReductionRef(evidence[1]!),
    review_ref: exactReductionRef(evidence[2]!),
    expected_output_ref: exactReductionRef(evidence[0]!),
    relation,
  });
  input.comparative_estimates = { baseline, intervention };
  const expected = syntheticEvaluationExpectedOutput(input);
  expected.baseline_damage = baseline;
  expected.intervention_damage = intervention;
  expected.absolute_reduction =
    intervention === '950'
      ? '50'
      : intervention === '900'
        ? '100'
        : intervention === null || baseline === null
          ? null
          : '120';
  expected.relative_reduction =
    expected.absolute_reduction !== null && baseline !== null
      ? { numerator: expected.absolute_reduction, denominator: baseline }
      : null;
  expected.target_met = expectedTarget;
  if (baseline === null || intervention === null) {
    expected.baseline_damage = null;
    expected.intervention_damage = null;
  }
  const expectedArtifact = original(expected);
  input.expected_output_refs = [exactReductionRef(expectedArtifact)];
  const inputArtifact = original(input);
  const ctx = evaluationFixtureContext(
    input,
    exactReductionRef(inputArtifact),
    target,
    [...evidence, protocol, expectedArtifact, inputArtifact],
  );
  return { input, ctx, inputArtifact, expectedArtifact };
}
function rebind(fixture: ReturnType<typeof numericalFixture>) {
  const input = original(fixture.input);
  fixture.ctx.evidence = [
    ...fixture.ctx.evidence.filter(({ id }) => id !== fixture.inputArtifact.id),
    input,
  ];
  fixture.ctx.input_ref = exactReductionRef(input);
  fixture.inputArtifact = input;
}
function assigned(
  content: unknown,
  assignmentId: string,
  kind: string,
): Artifact {
  const artifact = original(content, kind);
  return {
    ...artifact,
    producer: { kind: 'assignment', id: assignmentId },
    assignment_id: assignmentId,
    assignment_revision: 1,
    task_id: randomUUID(),
    run_id: randomUUID(),
    objective_revision: 1,
    generation: 1,
  };
}
function checkNumerical(
  input: ExternalEvaluationInput,
  ctx: EvaluationMethodContext,
) {
  const result = draftExternalEvaluation(input, ctx);
  const producer = randomUUID();
  const review = independentlyReviewExternalEvaluation(
    input,
    ctx,
    assigned(result.result, producer, 'reduction.external-evaluation'),
    assigned(result.learning, producer, 'reduction.evaluation-learning'),
    { assignment_id: randomUUID(), revision: 1 },
  );
  return { ...result, review };
}

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
  const directory = await mkdtemp(join(tmpdir(), 'haze-reduction-evaluation-'));
  let handler = createTaskHandler({
    stateDirectory: directory,
    mode: 'fixture',
    registry: createExecutionRegistry({ mode: 'fixture' }),
    env: {},
  });
  let server = createServer(handler),
    origin = await listen(server);
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
async function imported(
  api: Api,
  content: unknown,
  label = 'external-evaluation-engineering-example',
) {
  const body = {
    schema_version: 'haze.artifact.import.v3',
    filename: `${label}.json`,
    media_type: 'application/json',
    declared_origin:
      'Synthetic engineering verification only; no real external programme-effect evidence or service action.',
    content_base64: Buffer.from(JSON.stringify(content)).toString('base64'),
  };
  const key = randomUUID(),
    response = await api.call('/api/artifacts', body, key);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  if (label === 'evaluation-input') {
    const duplicate = await api.call('/api/artifacts', body, key);
    expect([200, 201]).toContain(duplicate.status);
    expect(duplicate.body).toEqual(response.body);
  }
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
      timeout: 30_000,
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
  kind: 'assessment' | 'planning' | 'pilot' | 'evaluation',
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
        : kind === 'evaluation'
          ? { registration_id: dependency }
          : {}),
  };
  const key = randomUUID(),
    response = await api.call(
      `/api/reduction-programmes/${id}/phases`,
      input,
      key,
    );
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  const receipt = reductionProgrammeMutationReceiptSchema.parse(response.body);
  expect(
    (await api.call(`/api/reduction-programmes/${id}/phases`, input, key)).body,
  ).toEqual(receipt);
  await settle(api, receipt.attempt!.task_id);
  return receipt.attempt!;
}
async function append(
  api: Api,
  id: string,
  record: PilotRecordBody | EvaluationRecordBody,
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
  const receipt = reductionProgrammeMutationReceiptSchema.parse(response.body),
    view = await programme(api, id);
  return {
    input,
    key,
    receipt,
    view,
    saved: view.records.find(
      ({ programme_revision }) => programme_revision === receipt.revision,
    )!,
  };
}
async function pilotProgramme(api: Api, unknownTiming = false) {
  const source = await imported(
    api,
    syntheticResidualImport(),
    'physical-scenario-original',
  );
  const preview = {
    schema_version: 'haze.reduction.preview-request.v1',
    selection: createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
      { artifact: source, row_ids: ['baseline-1', 'intervention-1'] },
    ]),
    candidate: syntheticReductionCandidate(),
  };
  const created = await api.call('/api/reduction-programmes', {
    schema_version: 'haze.reduction.programme.create.v1',
    expected_revision: 0,
    title: 'Synthetic external-evaluation lifecycle',
    accountable_owner: 'Fixture operator',
    scientific_owner: null,
    preview,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = reductionProgrammeMutationReceiptSchema.parse(
    created.body,
  ).programme_id;
  const assessment = await phase(api, id, 'assessment'),
    planning = await phase(api, id, 'planning', assessment.id);
  const proof = await imported(api, {
    origin: 'synthetic',
    statement: 'Invented pilot feasibility, design and approval statements.',
  });
  const input = suppliedCompletePilotInput(proof);
  input.origin = 'synthetic';
  input.design_review!.reviewed_at = new Date().toISOString();
  input.protocol_spec.digital_rule!.approval.approved_at =
    new Date().toISOString();
  input.protocol_spec.digital_rule!.scope.period = {
    start: '2026-01-01',
    end: '2027-12-31',
  };
  const pilotInput = await imported(api, input, 'pilot-input');
  await api.call(`/api/reduction-programmes/${id}/revisions`, {
    schema_version: 'haze.reduction.programme.revise.v1',
    expected_revision: (await programme(api, id)).programme.revision,
    reason:
      'Pin synthetic pilot design for evaluation engineering verification.',
    pilot_input_ref: pilotInput,
  });
  const pilot = await phase(api, id, 'pilot', planning.id);
  const pilotView = reductionPilotTaskViewSchema.parse(
    (await api.call(`/api/tasks/${pilot.task_id}/views/reduction-pilot`)).body,
  );
  expect(pilotView.review?.value.verdict).toBe('supported');
  const draft: PilotCurrentDraft = {
    attempt_id: pilot.id,
    feasibility: pilotView.feasibility!,
    protocol: pilotView.protocol!,
    review: pilotView.review!,
  };
  const registrationBody = pilotRegistrationRecordSchema.parse(
    syntheticPilotRegistration(draft),
  );
  if (unknownTiming) {
    registrationBody.outcome_access.collection = 'unknown';
    registrationBody.outcome_access.analysis = 'unknown';
  }
  const registration = await append(api, id, registrationBody);
  const rule = draft.protocol.value.specification.digital_rule!;
  const action = {
    ...syntheticDigitalActionRecord(registration.saved.id),
    action_id: 'synthetic-evaluated-action',
    occurred_at: new Date().toISOString(),
    status: 'confirmed' as const,
    rule: { id: rule.id, version: rule.version },
    permitted_action: rule.permitted_actions[0]!,
    scope: rule.scope,
    trigger_refs: rule.trigger_inputs.flatMap(({ evidence }) => evidence),
  };
  const rawReceipt = await imported(
    api,
    {
      origin: 'synthetic',
      statement: 'Original raw simulated digital-service payload.',
    },
    'synthetic-raw-action-receipt',
  );
  const receiptBody = syntheticActionReceipt(action);
  receiptBody.raw_receipt_ref = rawReceipt;
  const receipt = await imported(api, receiptBody, 'synthetic-action-receipt');
  const delivery = await append(api, id, { ...action, receipt_ref: receipt });
  expect(
    delivery.view.pilot!.actions.find(
      ({ record_id }) => record_id === delivery.saved.id,
    )?.effective_status,
  ).toBe('simulated');
  return {
    id,
    preview,
    source,
    assessment,
    planning,
    pilot,
    draft,
    registration,
    delivery,
    rawReceipt,
  };
}
async function evaluationInput(
  api: Api,
  scene: Awaited<ReturnType<typeof pilotProgramme>>,
  intervention: string | null = '880',
) {
  const report = await imported(
    api,
    {
      origin: 'synthetic',
      statement: 'Original invented externally calculated evaluation report.',
    },
    'external-report',
  );
  const data = await imported(
    api,
    { origin: 'synthetic', baseline: '1000', intervention },
    'external-data',
  );
  const externalReview = await imported(
    api,
    {
      origin: 'synthetic',
      statement:
        'Separate invented scientific review; credentials not authenticated.',
    },
    'external-review',
  );
  const input = syntheticExternalEvaluationInput({
    programme_id: scene.id,
    target_sha256: contractHash(scene.preview.selection.target),
    scope_sha256: contractHash(scene.preview.selection.target.scope),
    scope: scene.preview.selection.target.scope,
    registration_id: scene.registration.saved.id,
    protocol_ref: scene.draft.protocol.artifact,
    action_record_ids: [scene.delivery.saved.id],
    rules: [
      scene.delivery.saved.record.kind === 'digital_action'
        ? scene.delivery.saved.record.rule
        : { id: 'synthetic-alert-rule', version: '1' },
    ],
    report_ref: report,
    data_ref: data,
    review_ref: externalReview,
    expected_output_ref: report,
  });
  input.comparative_estimates.intervention = intervention;
  const expected = syntheticEvaluationExpectedOutput(input);
  if (intervention === '950') {
    expected.intervention_damage = '950';
    expected.absolute_reduction = '50';
    expected.relative_reduction = { numerator: '50', denominator: '1000' };
    expected.target_met = false;
  }
  if (intervention === null) {
    expected.baseline_damage = null;
    expected.intervention_damage = null;
    expected.absolute_reduction = null;
    expected.relative_reduction = null;
    expected.target_met = null;
  }
  input.expected_output_refs = [
    await imported(api, expected, 'independently-expected-output'),
  ];
  const inputRef = await imported(api, input, 'evaluation-input');
  const dossier = syntheticQualificationDossier(input, inputRef),
    dossierRef = await imported(api, dossier, 'qualification-dossier');
  const response = await api.call(
    `/api/reduction-programmes/${scene.id}/revisions`,
    {
      schema_version: 'haze.reduction.programme.revise.v1',
      expected_revision: (await programme(api, scene.id)).programme.revision,
      reason:
        'Pin exact original external evaluation and separate qualification dossier.',
      evaluation_input_ref: inputRef,
      evaluation_dossier_ref: dossierRef,
    },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return { input, inputRef, dossier, dossierRef };
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

describe('reviewed external evaluation boundaries', () => {
  it('does not satisfy a strict greater-than criterion with exact threshold equality', () => {
    const fixture = numericalFixture('1000', '900', false, 'greater_than');
    const output = checkNumerical(fixture.input, fixture.ctx);
    expect(output.result.status, JSON.stringify(output.result.reasons)).toBe(
      'supported',
    );
    expect(output.result.target_met).toBe(false);
    expect(output.review.verdict).toBe('supported');
  });
  it('rejects imported qualification/release flags as unsupported input fields', () => {
    const fixture = numericalFixture();
    expect(
      externalEvaluationInputSchema.safeParse({
        ...fixture.input,
        scientific_qualification: 'qualified',
        achieved_reduction: true,
      }).success,
    ).toBe(false);
  });
  it.each([
    { intervention: '880', difference: '120', met: true },
    { intervention: '950', difference: '50', met: false },
    { intervention: '900', difference: '100', met: true },
  ])(
    'independently reconstructs frozen $intervention residual arithmetic without qualifying the programme',
    ({ intervention, difference, met }) => {
      const fixture = numericalFixture('1000', intervention, met),
        output = checkNumerical(fixture.input, fixture.ctx);
      expect(output.result.status, JSON.stringify(output.result.reasons)).toBe(
        'supported',
      );
      expect(output.result.absolute_reduction).toBe(difference);
      expect(output.result.relative_reduction).toEqual({
        numerator: difference,
        denominator: '1000',
      });
      expect(output.result.target_met).toBe(met);
      expect(
        output.review.verdict,
        JSON.stringify(output.review.findings),
      ).toBe('supported');
      expect(output.result.scientific_qualification).toBe('unqualified');
      expect(output.result.achieved_reduction).toBe(false);
      expect(output.learning.publication).toBe('not_published');
    },
  );
  it.each(['uncertainty_bound', 'probability'] as const)(
    'does not substitute point arithmetic for unsupported %s',
    (kind) => {
      const fixture = numericalFixture();
      fixture.input.criterion.kind = kind;
      const expected = syntheticEvaluationExpectedOutput(fixture.input);
      expected.target_met = null;
      const expectedArtifact = original(expected);
      fixture.ctx.evidence = [
        ...fixture.ctx.evidence.filter(
          ({ id }) => id !== fixture.expectedArtifact.id,
        ),
        expectedArtifact,
      ];
      fixture.input.expected_output_refs = [
        exactReductionRef(expectedArtifact),
      ];
      rebind(fixture);
      const output = draftExternalEvaluation(fixture.input, fixture.ctx);
      expect(output.result.status).toBe('gap');
      expect(output.result.target_met).toBeNull();
      expect(output.learning.outcome).toBe('insufficient_evidence');
      expect(output.result.reasons.join(' ')).toMatch(
        /uncertainty|probability|unsupported|point/i,
      );
    },
  );
  it('retains unknown comparative damage as an honest independently reviewed gap', () => {
    const fixture = numericalFixture('1000', null, null),
      output = checkNumerical(fixture.input, fixture.ctx);
    expect(output.result.status).toBe('gap');
    expect(output.result.intervention_damage).toBeNull();
    expect(output.result.target_met).toBeNull();
    expect(output.review.verdict).toBe('supported');
    expect(output.learning.outcome).toBe('insufficient_evidence');
  });
  it.each([
    'programme',
    'scope',
    'protocol',
    'delivery',
    'source-method',
    'design',
    'deviation',
  ] as const)(
    'withholds compatible support when %s differs from its bound evidence',
    (field) => {
      const fixture = numericalFixture();
      if (field === 'programme') fixture.input.programme_id = randomUUID();
      if (field === 'scope')
        fixture.input.scope.population = 'Another evaluated population';
      if (field === 'protocol')
        fixture.input.protocol.protocol_ref = {
          ...fixture.input.protocol.protocol_ref,
          id: randomUUID(),
        };
      if (field === 'delivery')
        fixture.input.delivery.action_record_ids = [randomUUID()];
      if (field === 'source-method')
        fixture.input.source_method.version = 'unreviewed-version';
      if (field === 'design')
        fixture.input.design.identification = 'before_after_only';
      if (field === 'deviation')
        fixture.ctx.delivery.unresolved_material_deviation_record_ids = [
          randomUUID(),
        ];
      rebind(fixture);
      const output = draftExternalEvaluation(fixture.input, fixture.ctx);
      expect(output.result.status, field).not.toBe('supported');
      if (output.result.status === 'incompatible')
        expect(output.result.target_met).toBeNull();
      expect(output.learning.outcome).toBe('insufficient_evidence');
      expect(output.result.reasons.length).toBeGreaterThan(0);
    },
  );
  it('rejects altered products and self-review rather than trusting imported approval flags', () => {
    const fixture = numericalFixture(),
      output = draftExternalEvaluation(fixture.input, fixture.ctx),
      producer = randomUUID();
    const result = assigned(
      { ...output.result, target_met: false },
      producer,
      'reduction.external-evaluation',
    );
    const learning = assigned(
      output.learning,
      producer,
      'reduction.evaluation-learning',
    );
    const rejected = independentlyReviewExternalEvaluation(
      fixture.input,
      fixture.ctx,
      result,
      learning,
      { assignment_id: randomUUID(), revision: 1 },
    );
    expect(rejected.verdict).toBe('rejected');
    const self = independentlyReviewExternalEvaluation(
      fixture.input,
      fixture.ctx,
      assigned(output.result, producer, 'reduction.external-evaluation'),
      learning,
      { assignment_id: producer, revision: 1 },
    );
    expect(self.verdict).toBe('rejected');
    expect(self.scientific_qualification).toBe('unqualified');
  });
});

describe('external evaluation programme lifecycle', () => {
  it('retains exact synthetic evaluation, review, human qualification/withdrawal and learning across restart and source hold', async () => {
    const api = await setup(),
      scene = await pilotProgramme(api),
      originals = await evaluationInput(api, scene);
    const attempt = await phase(
      api,
      scene.id,
      'evaluation',
      scene.registration.saved.id,
    );
    expect(
      api.runtime.store.read(attempt.task_id, localTaskIdentity)
        .original_request.context_refs,
    ).toContainEqual(scene.rawReceipt);
    const response = await api.call(
      `/api/tasks/${attempt.task_id}/views/reduction-evaluation`,
    );
    expect(response.status).toBe(200);
    const output = evaluationTaskViewSchema.parse(response.body);
    expect(output.result?.value.status, JSON.stringify(output.reasons)).toBe(
      'gap',
    );
    expect(output.result?.value.target_met).toBe(true);
    expect(output.review?.value.verdict).toBe('supported');
    expect(output.learning?.value.outcome).toBe('insufficient_evidence');
    const before = await programme(api, scene.id);
    expect(before.evaluation?.claim.eligible).toBe(false);
    expect(before.achieved_reduction).toBe(false);
    const record: EvaluationRecordBody = {
      kind: 'evaluation_qualification',
      decision: 'qualified',
      result_ref: output.result!.artifact,
      technical_review_ref: output.review!.artifact,
      dossier_ref: originals.dossierRef,
      adopted_by: 'Explicit fixture operator attestation',
      attested_at: new Date().toISOString(),
      reason:
        'Engineering adoption record only; synthetic sources cannot establish actual programme effect.',
      supersedes_record_id: null,
    };
    const adopted = await append(api, scene.id, record, 'adopt-evaluation');
    expect(adopted.view.evaluation?.claim.eligible).toBe(false);
    expect(adopted.view.evaluation?.operational_release).toBe(
      'gated_pending_non_synthetic_trace',
    );
    const withdrawn = await append(api, scene.id, {
      ...record,
      decision: 'withdrawn',
      reason:
        'Local operator withdraws the explicit qualification attestation.',
      supersedes_record_id: adopted.saved.id,
    });
    expect(withdrawn.view.evaluation?.qualification.status).toBe('withdrawn');
    expect(withdrawn.view.evaluation?.claim.eligible).toBe(false);
    expect(
      (
        await api.call(
          `/api/reduction-programmes/${scene.id}/records`,
          adopted.input,
          adopted.key,
        )
      ).body,
    ).toEqual(adopted.receipt);
    const historical = reductionProgrammeHistorySchema.parse(
      (await api.call(`/api/reduction-programmes/${scene.id}/history`)).body,
    );
    await api.restart();
    expect(stable(await programme(api, scene.id))).toEqual(
      stable(withdrawn.view),
    );
    expect(
      reductionProgrammeHistorySchema.parse(
        (await api.call(`/api/reduction-programmes/${scene.id}/history`)).body,
      ),
    ).toEqual(historical);
    expect(
      api.runtime.store.artifact(
        output.learning!.artifact.id,
        localTaskIdentity,
      ).sha256,
    ).toBe(output.learning!.artifact.sha256);
    const worldScope = { ...localTaskIdentity, mode: 'fixture' as const },
      worldRecord = api.runtime.store.world.lookup(worldScope, {
        kind: 'artifact_reference',
        external_id: `artifact:${originals.inputRef.id}:${originals.inputRef.version}`,
        limit: 2,
      })[0]!;
    api.runtime.store.world.hold(
      worldScope,
      worldRecord.ref,
      'External evaluation original held for applicability review.',
      'unknown_impact',
    );
    const held = await programme(api, scene.id);
    expect(held.evaluation?.claim.eligible).toBe(false);
    expect(held.evaluation?.current?.state).not.toBe('current');
    expect(
      held.attempts.find(({ attempt: bound }) => bound.id === attempt.id)
        ?.currency,
    ).toBe('stale');
    expect(held.evaluation?.qualification.status).not.toBe('qualified');
    expect(held.records).toEqual(withdrawn.view.records);
    expect(held.capacity.charged_tool_calls).toBe(
      withdrawn.view.capacity.charged_tool_calls,
    );
    await api.restart('live');
    expect(
      (await api.call(`/api/reduction-programmes/${scene.id}`)).status,
    ).toBe(404);
    await api.restart('fixture');
    expect((await programme(api, scene.id)).evaluation?.claim.eligible).toBe(
      false,
    );
  }, 180_000);
  it('preserves rollback/idempotency and evaluation phase budgets against generic task mutation', async () => {
    const api = await setup(),
      scene = await pilotProgramme(api, true),
      originals = await evaluationInput(api, scene);
    const first = await phase(
      api,
      scene.id,
      'evaluation',
      scene.registration.saved.id,
    );
    const current = await programme(api, scene.id),
      output = current.evaluation!.current!;
    expect(output.result!.value.reasons.join(' ')).toMatch(
      /registration|timing|prespecif/i,
    );
    const record: EvaluationRecordBody = {
      kind: 'evaluation_qualification',
      decision: 'conditional',
      result_ref: output.result!.artifact,
      technical_review_ref: output.review!.artifact,
      dossier_ref: originals.dossierRef,
      adopted_by: 'Fixture operator',
      attested_at: new Date().toISOString(),
      reason: 'Synthetic conditional engineering attestation.',
      supersedes_record_id: null,
    };
    const body = {
      schema_version: 'haze.reduction.programme.record-request.v1',
      expected_revision: current.programme.revision,
      record,
    };
    expect(() =>
      api.runtime.store.transaction(() => {
        service(api).appendRecord(
          scene.id,
          body,
          'rolled-back-adoption',
          localTaskIdentity,
        );
        throw new Error('Injected evaluation record rollback.');
      }),
    ).toThrow('Injected evaluation record rollback');
    expect((await programme(api, scene.id)).records).toEqual(current.records);
    const conditional = await append(
      api,
      scene.id,
      record,
      'rolled-back-adoption',
    );
    expect(conditional.view.evaluation?.claim.eligible).toBe(false);
    const task = api.runtime.store.read(first.task_id, localTaskIdentity);
    const unbound = api.runtime.admit(
      structuredClone(task.original_request),
      'unbound-evaluation-copy',
      localTaskIdentity,
    );
    const beforeBypass = await programme(api, scene.id);
    await expect
      .poll(
        () => api.runtime.store.read(unbound.task_id, localTaskIdentity).status,
        { timeout: 30_000 },
      )
      .not.toMatch(/^(queued|running)$/);
    const unboundTask = api.runtime.store.read(
      unbound.task_id,
      localTaskIdentity,
    );
    expect(
      unboundTask.assignments.some(({ error, gaps }) =>
        JSON.stringify({ error, gaps }).includes('programme'),
      ),
    ).toBe(true);
    const unboundView = evaluationTaskViewSchema.parse(
      (
        await api.call(
          `/api/tasks/${unbound.task_id}/views/reduction-evaluation`,
        )
      ).body,
    );
    expect(unboundView.result).toBeNull();
    expect((await programme(api, scene.id)).capacity).toEqual(
      beforeBypass.capacity,
    );
    const denied = await api.call(`/api/tasks/${task.id}/control`, {
      schema_version: 'haze.task.control.v3',
      ...fence(task),
      action: 'continue',
    });
    expect([403, 409]).toContain(denied.status);
    for (let index = 0; index < 2; index++) {
      const currentTask = api.runtime.store.read(task.id, localTaskIdentity),
        before = await programme(api, scene.id);
      const response = await api.call(`/api/tasks/${task.id}/control`, {
        schema_version: 'haze.task.control.v3',
        ...fence(currentTask),
        action: 'continue',
        coordination: {
          owner_id: scene.id,
          expected_revision: before.programme.revision,
        },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      await settle(api, task.id);
    }
    const exhausted = await programme(api, scene.id);
    expect(exhausted.capacity.remaining_attempts.evaluation).toBe(0);
    const last = api.runtime.store.read(task.id, localTaskIdentity);
    const over = await api.call(`/api/tasks/${task.id}/control`, {
      schema_version: 'haze.task.control.v3',
      ...fence(last),
      action: 'continue',
      coordination: {
        owner_id: scene.id,
        expected_revision: exhausted.programme.revision,
      },
    });
    expect([409, 422]).toContain(over.status);
    expect(
      api.runtime.store.read(task.id, localTaskIdentity).current_run_id,
    ).toBe(last.current_run_id);
    expect((await programme(api, scene.id)).evaluation?.claim.eligible).toBe(
      false,
    );
  }, 180_000);
});
