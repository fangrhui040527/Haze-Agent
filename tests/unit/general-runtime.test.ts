import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import type {
  AgentModel,
  AgentModelInput,
} from '../../app/adapters/agent-model.js';
import { TaskStore } from '../../app/tasks/store.js';

const cleanups: (() => Promise<void>)[] = [];
/** Small scripted answers still exercise the current strict decision envelope and fences. */
function scriptedManager(model: AgentModel): AgentModel {
  const envelope = (text: string, input: AgentModelInput) => {
    const action = JSON.parse(text) as Record<string, unknown>;
    if (input.role !== 'Manager' || action.action) return text;
    const context = input.context as {
      run_id: string;
      generation: number;
      objective_revision: number;
      plan_revision: number;
      event_cursor: number;
      request: { objective: string };
    };
    return JSON.stringify({
      id: action.id,
      run_id: context.run_id,
      generation: context.generation,
      objective_revision: context.objective_revision,
      plan_revision: context.plan_revision,
      event_cursor: context.event_cursor,
      explanation: 'Scripted decision for the runtime behavior under test.',
      references: [],
      interpretation: {
        scope: context.request.objective,
        deliverables: ['A direct answer.'],
        assumptions: [],
        intended_use: 'Informational response.',
        stopping_conditions: ['Return the requested answer.'],
      },
      action:
        action.type === 'respond'
          ? {
              type: 'finalize',
              answer: action.answer,
              work_products: [],
              sources: [],
              uncertainty: action.uncertainty ?? [],
              unfinished: [],
            }
          : { type: 'question', prompt: action.prompt },
    });
  };
  return {
    ...model,
    complete: async (input, signal) =>
      envelope(await model.complete(input, signal), input),
    ...(model.completeWithReceipt
      ? {
          completeWithReceipt: async (
            input: AgentModelInput,
            signal: AbortSignal,
          ) => {
            const completion = await model.completeWithReceipt!(input, signal);
            return { ...completion, text: envelope(completion.text, input) };
          },
        }
      : {}),
  };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function runtime(
  options: {
    model?: AgentModel;
    mode?: 'fixture' | 'live';
    acceptancePolicy?: 'research-v1';
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'haze-general-runtime-'));
  const instance = new TaskRuntime({
    stateDirectory: directory,
    registry: createExecutionRegistry({ mode: options.mode ?? 'fixture' }),
    mode: options.mode ?? 'fixture',
    ...(options.acceptancePolicy
      ? { acceptancePolicy: options.acceptancePolicy }
      : {}),
    ...(options.model ? { model: scriptedManager(options.model) } : {}),
  });
  cleanups.push(async () => {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  });
  return instance;
}
async function until(
  instance: TaskRuntime,
  id: string,
  predicate: (task: TaskRecord) => boolean,
) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const task = instance.store.read(id, localTaskIdentity);
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Task did not reach expected state: ${JSON.stringify(instance.store.read(id, localTaskIdentity))}`,
  );
}
const terminal = (task: TaskRecord) =>
  [
    'completed',
    'failed',
    'waiting',
    'paused',
    'timed_out',
    'cancelled',
  ].includes(task.status);
function expectation(task: TaskRecord) {
  return {
    expected_objective_revision: task.objective_revision,
    expected_run_id: task.current_run_id,
    expected_generation: task.generation,
    expected_state_revision: task.state_revision,
  };
}
function projectedWorldRecords(instance: TaskRuntime, task: TaskRecord) {
  return instance.store.world.lookup(
    { ...localTaskIdentity, mode: task.mode },
    { limit: 50 },
  );
}

describe('general runtime', () => {
  it('pauses an unknown tool outcome without substituting a source gap, then explicitly replaces the charged attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-unknown-tool-'));
    const registry = createExecutionRegistry({ mode: 'fixture' });
    const tool = [...registry.tools.values()][0]!;
    let calls = 0;
    registry.tools.set(tool.id, {
      ...tool,
      execute: (input, context) => {
        calls++;
        return calls === 1
          ? Promise.reject(
              Object.assign(
                new Error('Source connection lost before receipt.'),
                { outcome: 'unknown' as const },
              ),
            )
          : tool.execute(input, context);
      },
    });
    const instance = new TaskRuntime({
      stateDirectory: directory,
      registry,
      mode: 'fixture',
    });
    cleanups.push(async () => {
      await instance.close();
      await rm(directory, { recursive: true, force: true });
    });
    const admission = instance.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Investigate PM2.5.',
        scope: {
          location: 'Kuala Lumpur',
          period: {
            start: '2026-10-01T00:00:00Z',
            end: '2026-10-01T03:00:00Z',
          },
        },
      },
      'unknown-source',
    );
    const paused = await until(instance, admission.task_id, (task) =>
      ['paused', 'failed'].includes(task.status),
    );
    expect(paused.status, paused.error?.message).toBe('paused');
    expect(paused.usage.tool_calls).toBe(1);
    expect(
      paused.assignments.find(
        (assignment) => assignment.definition_id === 'pm25.retrieve',
      )?.outputs,
    ).toEqual([]);
    expect(
      instance.store.attempts(paused.id, localTaskIdentity)[0],
    ).toMatchObject({ status: 'unknown', accepted: false });
    instance.control(
      paused.id,
      {
        schema_version: 'haze.task.control.v3',
        ...expectation(paused),
        action: 'resume',
      },
      'replace-source',
    );
    const complete = await until(instance, paused.id, (task) =>
      ['completed', 'failed'].includes(task.status),
    );
    expect(complete.status, complete.error?.message).toBe('completed');
    expect(complete.usage.tool_calls).toBe(2);
    expect(complete.limits.deadline).toBe(paused.limits.deadline);
    expect(calls).toBe(2);
  });
  it('pauses charged provider calls with unknown remote outcomes until explicit resume', async () => {
    let calls = 0;
    const unknown = Object.assign(
      new Error('The provider connection timed out without a receipt.'),
      { outcome: 'unknown' as const },
    );
    const instance = await runtime({
      mode: 'live',
      model: {
        selection: { provider: 'test', model: 'unknown-outcome' },
        complete: () => {
          calls++;
          return calls === 1
            ? Promise.reject(unknown)
            : Promise.resolve(
                JSON.stringify({
                  id: 'replacement',
                  type: 'respond',
                  answer: 'Answer from explicitly admitted replacement.',
                  uncertainty: [],
                }),
              );
        },
      },
    });
    const admission = instance.admit(
      { schema_version: 'haze.task.request.v3', objective: 'Say hello.' },
      'unknown-outcome',
    );
    const paused = await until(instance, admission.task_id, (task) =>
      ['paused', 'failed'].includes(task.status),
    );
    expect(paused.status, paused.error?.message).toBe('paused');
    expect(paused.usage.model_calls).toBe(1);
    expect(
      instance.store.attempts(paused.id, localTaskIdentity)[0],
    ).toMatchObject({ status: 'unknown', accepted: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    instance.control(
      paused.id,
      {
        schema_version: 'haze.task.control.v3',
        ...expectation(paused),
        action: 'resume',
      },
      'replace-unknown',
    );
    const complete = await until(instance, paused.id, (task) =>
      ['completed', 'failed'].includes(task.status),
    );
    expect(complete.status, complete.error?.message).toBe('completed');
    expect(complete.result?.answer).toBe(
      'Answer from explicitly admitted replacement.',
    );
    expect(complete.usage.model_calls).toBe(2);
    expect(complete.limits.deadline).toBe(paused.limits.deadline);
    expect(complete.limits.max_model_calls).toBe(paused.limits.max_model_calls);
    expect(
      instance.store.attempts(paused.id, localTaskIdentity)[0]?.status,
    ).toBe('unknown');
  });
  it('pauses unfinished legacy Manager runs for explicit linked continuation without reinterpreting old actions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-pending-action-'));
    const store = new TaskStore(directory);
    store.configureDefinitions({
      agents: { Manager: 'manager.v3' },
      capabilities: { 'core.manager': '3' },
      tools: [],
      assignments: {
        'core.manager.plan': {
          version: '3',
          capability: 'core.manager',
          role: 'Manager',
          tools: [],
        },
      },
    });
    const admission = store.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Say hello.',
        context_refs: [],
        constraints: [],
        desired_deliverables: [],
      },
      localTaskIdentity,
      'pending',
      { mode: 'live' },
    );
    const assignment = store.createAssignments(
      admission.task.id,
      admission.task.current_run_id,
      1,
      [
        {
          definition_id: 'core.manager.plan',
          definition_version: '3',
          capability: 'core.manager',
          role: 'Manager',
          brief: 'Choose a response.',
          max_model_calls: 1,
        },
      ],
    )[0]!;
    store.acquireAssignment(admission.task.id, assignment.id);
    const attempt = store.chargeAttempt(
      admission.task.id,
      assignment.id,
      'model',
    );
    const action = {
      id: 'persisted-response',
      type: 'respond',
      answer: 'Recovered accepted response.',
      uncertainty: [],
    };
    const response = {
      text: JSON.stringify(action),
      receipt: {
        response_model: null,
        response_id: null,
        input_tokens: null,
        output_tokens: null,
      },
    };
    store.completeAttempt(admission.task.id, attempt.id, {
      output: response.text,
      receipt: response.receipt,
    });
    store.recordAction(
      admission.task.id,
      assignment.id,
      action.id,
      response,
      action,
    );
    store.db
      .prepare('DELETE FROM manager_state WHERE run_id=?')
      .run(admission.task.current_run_id);
    store.close();
    let calls = 0;
    const instance = new TaskRuntime({
      stateDirectory: directory,
      mode: 'live',
      registry: createExecutionRegistry({ mode: 'live' }),
      model: {
        selection: { provider: 'test', model: 'unused' },
        complete: () => {
          calls++;
          return Promise.reject(new Error('The provider must not be called.'));
        },
      },
    });
    cleanups.push(async () => {
      await instance.close();
      await rm(directory, { recursive: true, force: true });
    });
    const completed = await until(instance, admission.task.id, (task) =>
      ['paused', 'failed'].includes(task.status),
    );
    expect(completed.status, completed.error?.message).toBe('paused');
    expect(completed.manager?.upgrade_required).toContain('Manager');
    expect(completed.result).toBeUndefined();
    expect(completed.usage.model_calls).toBe(1);
    expect(calls).toBe(0);
  });
  it('explains source material without global domain fields and commits exact citations', async () => {
    const instance = await runtime();
    const source = instance.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'notes.md',
        media_type: 'text/markdown',
        content_base64: Buffer.from(
          'A knowledge graph records entities and the relationships between them.',
        ).toString('base64'),
      },
      'source',
    );
    const admitted = instance.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Explain knowledge graphs from my notes.',
        context_refs: [
          { id: source.id, version: source.version, sha256: source.sha256 },
        ],
      },
      'task',
    );
    const task = await until(instance, admitted.task_id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.result?.sources[0]?.artifact).toEqual({
      id: source.id,
      version: 1,
      sha256: source.sha256,
    });
    expect(task.result?.answer).toContain('[S1]');
    expect(task.result?.provenance.mode).toBe('fixture');
    expect(task.result?.review.status).toBe('supported');
    expect(
      task.assignments.some((item) => item.role === 'EvidenceCritic'),
    ).toBe(true);
    const projected = projectedWorldRecords(instance, task);
    expect(projected.map((record) => record.kind)).toEqual(
      expect.arrayContaining([
        'synthesis_source_reference',
        'synthesis_citation',
        'evidence_synthesis_bundle',
        'evidence_synthesis_review',
      ]),
    );
    const bundle = projected.find(
      (record) => record.kind === 'evidence_synthesis_bundle',
    )!;
    const acceptance = instance.store.world.acceptancesForRecord(
      { ...localTaskIdentity, mode: task.mode },
      bundle.ref.id,
    )[0];
    expect(acceptance?.status).toBe('not_eligible');
    expect(acceptance?.policy).toMatchObject({ id: 'disabled', version: '0' });
  });
  it('accepts a reviewed synthesis only when the server enables its matching policy', async () => {
    const instance = await runtime({ acceptancePolicy: 'research-v1' });
    const source = instance.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'research-notes.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from(
          'A model represents the relationships among observed entities.',
        ).toString('base64'),
      },
      'policy-source',
    );
    const admitted = instance.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Summarize this source.',
        context_refs: [
          { id: source.id, version: source.version, sha256: source.sha256 },
        ],
      },
      'policy-task',
    );
    const task = await until(instance, admitted.task_id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    const worldRecords = projectedWorldRecords(instance, task);
    const bundle = worldRecords.find(
      (record) => record.kind === 'evidence_synthesis_bundle',
    );
    expect(bundle).toBeDefined();
    const acceptance = instance.store.world.acceptancesForRecord(
      { ...localTaskIdentity, mode: task.mode },
      bundle!.ref.id,
    )[0];
    expect(acceptance?.status).toBe('accepted');
    expect(acceptance?.stated_use).toBe('evidence-synthesis');
    expect(acceptance?.policy).toMatchObject({
      id: 'research-v1',
      version: '1',
    });
    expect(typeof acceptance?.expires_at).toBe('string');
    const extractor = task.assignments.find(
      (assignment) => assignment.definition_id === 'evidence-synthesis.extract',
    )!;
    instance.store.update(
      task.id,
      localTaskIdentity,
      'correct-accepted-source',
      {
        schema_version: 'haze.task.update.v3',
        ...expectation(task),
        kind: 'correction',
        passage: 'The cited material needs correction.',
        affected_assignment_ids: [extractor.id],
      },
    );
    expect(() =>
      instance.store.saveResult(
        task.id,
        task.current_run_id,
        task.generation,
        task.result!,
      ),
    ).toThrow('fenced');
    expect(
      instance.store.world.currentAcceptance(
        { ...localTaskIdentity, mode: task.mode },
        instance.store.world.acceptancesForRecord(
          { ...localTaskIdentity, mode: task.mode },
          bundle!.ref.id,
        )[0]!.id,
        {
          policyHash: instance.store.worldAcceptancePolicy.sha256,
        },
      )?.status,
    ).toBe('held');
  });
  it('places a support hold when a required tool grant is revoked', async () => {
    const instance = await runtime({ acceptancePolicy: 'research-v1' });
    const source = instance.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'grant-source.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from(
          'A source connects observations to a named entity.',
        ).toString('base64'),
      },
      'grant-source',
    );
    const admitted = instance.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Summarize this source.',
        context_refs: [
          { id: source.id, version: source.version, sha256: source.sha256 },
        ],
      },
      'grant-task',
    );
    const task = await until(instance, admitted.task_id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    const records = projectedWorldRecords(instance, task);
    const bundle = records.find(
      (record) => record.kind === 'evidence_synthesis_bundle',
    )!;
    expect(
      instance.store.world.acceptancesForRecord(
        { ...localTaskIdentity, mode: task.mode },
        bundle.ref.id,
      )[0]?.status,
    ).toBe('accepted');
    instance.store.control(task.id, localTaskIdentity, 'revoke-context-grant', {
      schema_version: 'haze.task.control.v3',
      ...expectation(task),
      action: 'revoke',
      revoked_tools: ['world.context'],
      reason: 'Context access was withdrawn.',
    });
    expect(
      instance.store.world.acceptancesForRecord(
        { ...localTaskIdentity, mode: task.mode },
        bundle.ref.id,
      )[0]?.status,
    ).toBe('held');
  });
  it('persists a source question and answers it with a newly imported source', async () => {
    const instance = await runtime();
    const admitted = instance.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Explain knowledge graphs.',
      },
      'task',
    );
    const waiting = await until(
      instance,
      admitted.task_id,
      (task) => task.status === 'waiting',
    );
    expect(waiting.questions).toHaveLength(1);
    const source = instance.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'answer.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from(
          'A graph links records with typed relationships.',
        ).toString('base64'),
      },
      'source',
    );
    instance.update(
      waiting.id,
      {
        schema_version: 'haze.task.update.v3',
        ...expectation(waiting),
        kind: 'clarification',
        passage: 'Use this imported source.',
        question_id: waiting.questions[0]!.id,
        context_refs: [
          { id: source.id, version: source.version, sha256: source.sha256 },
        ],
      },
      'clarify',
    );
    const task = await until(instance, admitted.task_id, (value) =>
      ['completed', 'failed'].includes(value.status),
    );
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.corrections[0]?.passage).toBe('Use this imported source.');
    expect(task.result?.sources[0]?.artifact.id).toBe(source.id);
  });
  it('runs PM2.5 methods, independent checks, and a persisted bounded peer exchange', async () => {
    const instance = await runtime();
    const admitted = instance.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective:
          'Investigate PM2.5 for Kuala Lumpur during 2026-10-01T00:00:00Z to 2026-10-01T03:00:00Z.',
        scope: {
          location: 'Kuala Lumpur',
          period: {
            start: '2026-10-01T00:00:00Z',
            end: '2026-10-01T03:00:00Z',
          },
        },
      },
      'pm25',
    );
    const task = await until(instance, admitted.task_id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.result?.completion).toBe('partial');
    expect(task.result?.answer).toContain('[E1]');
    expect(
      task.result?.work_products.some(
        (ref) =>
          instance.store.artifact(ref.id, localTaskIdentity).kind ===
          'pm25.analysis',
      ),
    ).toBe(true);
    expect(
      instance.store
        .events(task.id, localTaskIdentity)
        .events.filter((event) => event.type === 'peer_message_sent'),
    ).toHaveLength(2);
    expect(task.usage.tool_calls).toBe(1);
    const projected = projectedWorldRecords(instance, task);
    expect(projected.map((record) => record.kind)).toEqual(
      expect.arrayContaining([
        'pm25_location',
        'pm25_modeled_capture',
        'pm25_analysis_reference',
        'pm25_numerical_review_reference',
      ]),
    );
    const relationshipCount = instance.store.db
      .prepare(
        `SELECT COUNT(*) AS count FROM world_relationships
         WHERE principal=? AND workspace=? AND mode=?`,
      )
      .get(
        localTaskIdentity.principal,
        localTaskIdentity.workspace,
        task.mode,
      ) as { count: number };
    expect(relationshipCount.count).toBeGreaterThan(0);
    expect(
      task.result?.provenance.receipts.some(
        (receipt) =>
          typeof receipt === 'object' &&
          receipt !== null &&
          'kind' in receipt &&
          receipt.kind === 'tool',
      ),
    ).toBe(true);
  });
  it('keeps an explicitly scoped episode investigation partial when evidence branches are unconfigured', async () => {
    const instance = await runtime();
    const admitted = instance.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Investigate the October haze episode.',
        scope: {
          episode_id: 'episode-2026-10',
          label: 'October haze episode',
          geography: { id: 'klang', label: 'Klang' },
          period: {
            start: '2026-10-01T00:00:00Z',
            end: '2026-10-02T00:00:00Z',
          },
        },
      },
      'episode-world-model',
    );
    const task = await until(instance, admitted.task_id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    expect(task.result?.completion).toBe('partial');
    const projected = projectedWorldRecords(instance, task);
    expect(projected.map((record) => record.kind)).toEqual(
      expect.arrayContaining(['episode_context', 'episode_evidence_gap']),
    );
    const gap = projected.find(
      (record) => record.kind === 'episode_evidence_gap',
    )!;
    expect(gap.payload).toMatchObject({
      branches: [
        {
          id: 'observations',
          status: 'unresolved',
          source_availability: 'not_configured',
        },
        {
          id: 'attribution',
          status: 'unresolved',
          source_availability: 'not_configured',
        },
      ],
    });
  });
  it('rejects old protocol and client authority, and deduplicates exact admission', async () => {
    const instance = await runtime();
    expect(() =>
      instance.admit(
        { schema_version: 'haze.task.request.v1', objective: 'test' },
        'old',
      ),
    ).toThrow('v1/v2 have been retired');
    expect(() =>
      instance.admit(
        {
          schema_version: 'haze.task.request.v3',
          objective: 'test',
          permissions: { tools: [] },
        },
        'authority',
      ),
    ).toThrow();
    const request = {
      schema_version: 'haze.task.request.v3',
      objective: 'Explain the missing source.',
    };
    const first = instance.admit(request, 'once');
    expect(instance.admit(request, 'once')).toEqual({ ...first, reused: true });
    expect(() =>
      instance.admit({ ...request, objective: 'Different' }, 'once'),
    ).toThrow();
    await until(instance, first.task_id, terminal);
  });
  it('passes output-token ceilings and preserves actual provider receipts on direct responses', async () => {
    let ceiling = 0;
    const model: AgentModel = {
      selection: { provider: 'test-provider', model: 'configured-route' },
      complete: () => Promise.resolve(''),
      completeWithReceipt: (input) => {
        ceiling = input.max_output_tokens!;
        return Promise.resolve({
          text: JSON.stringify({
            id: 'direct',
            type: 'respond',
            answer: 'An objective-only answer.',
            uncertainty: [],
          }),
          receipt: {
            response_model: 'actual-response-model',
            response_id: 'response-123',
            input_tokens: 10,
            output_tokens: 20,
          },
        });
      },
    };
    const instance = await runtime({ model, mode: 'live' });
    const admitted = instance.admit(
      { schema_version: 'haze.task.request.v3', objective: 'Say hello.' },
      'direct',
    );
    const task = await until(instance, admitted.task_id, terminal);
    expect(task.status, task.error?.message).toBe('completed');
    expect(ceiling).toBe(1200);
    expect(JSON.stringify(task.result?.provenance.receipts)).toContain(
      'actual-response-model',
    );
    expect(task.usage.model_calls).toBe(1);
  });
  it('fences paused calls, retains late receipts, and charges explicit replacement without resetting resources', async () => {
    let release: ((value: string) => void) | undefined;
    let releaseReplacement: ((value: string) => void) | undefined;
    let calls = 0;
    const model: AgentModel = {
      selection: { provider: 'test', model: 'bounded' },
      complete: async () => {
        calls++;
        if (calls === 1)
          return new Promise<string>((resolve) => {
            release = resolve;
          });
        return new Promise<string>((resolve) => {
          releaseReplacement = resolve;
        });
      },
    };
    const instance = await runtime({ model, mode: 'live' });
    const admission = instance.admit(
      { schema_version: 'haze.task.request.v3', objective: 'Say hello.' },
      'paused',
    );
    const running = await until(
      instance,
      admission.task_id,
      (task) => task.usage.model_calls === 1,
    );
    instance.control(
      running.id,
      {
        schema_version: 'haze.task.control.v3',
        ...expectation(running),
        action: 'pause',
      },
      'pause',
    );
    release!(
      JSON.stringify({
        id: 'old',
        type: 'respond',
        answer: 'Stale answer.',
        uncertainty: [],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const paused = instance.store.read(running.id, localTaskIdentity);
    expect(paused.status).toBe('paused');
    expect(
      instance.store.attempts(running.id, localTaskIdentity)[0]?.accepted,
    ).toBe(false);
    expect(
      instance.store.attempts(running.id, localTaskIdentity)[0]?.output,
    ).toContain('Stale answer');
    instance.control(
      paused.id,
      {
        schema_version: 'haze.task.control.v3',
        ...expectation(paused),
        action: 'resume',
      },
      'resume',
    );
    const replacing = await until(
      instance,
      running.id,
      (task) => task.usage.model_calls === 2,
    );
    const duplicateReceipt = instance.control(
      running.id,
      {
        schema_version: 'haze.task.control.v3',
        ...expectation(running),
        action: 'pause',
      },
      'pause',
    );
    expect(duplicateReceipt.confirmed).toBe('paused');
    expect(instance.store.read(running.id, localTaskIdentity).generation).toBe(
      replacing.generation,
    );
    releaseReplacement!(
      JSON.stringify({
        id: 'replacement',
        type: 'respond',
        answer: 'Explicitly resumed answer.',
        uncertainty: [],
      }),
    );
    const complete = await until(instance, running.id, (task) =>
      ['completed', 'failed'].includes(task.status),
    );
    expect(complete.status, complete.error?.message).toBe('completed');
    expect(complete.result?.answer).toBe('Explicitly resumed answer.');
    expect(complete.usage.model_calls).toBe(2);
    expect(complete.limits.deadline).toBe(running.limits.deadline);
    expect(complete.assignments).toHaveLength(1);
  });
  it('corrects investigation scope and keeps old products held until explicit Manager reassessment', async () => {
    const instance = await runtime();
    const admission = instance.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective:
          'Investigate PM2.5 for Kuala Lumpur during 2026-10-01T00:00:00Z to 2026-10-01T03:00:00Z.',
        scope: {
          location: 'Kuala Lumpur',
          period: {
            start: '2026-10-01T00:00:00Z',
            end: '2026-10-01T03:00:00Z',
          },
        },
      },
      'corrected',
    );
    const before = await until(instance, admission.task_id, terminal);
    expect(before.status, before.error?.message).toBe('completed');
    const affected = before.assignments
      .filter((assignment) =>
        ['pm25.retrieve', 'pm25.analyze', 'pm25.check'].includes(
          assignment.definition_id,
        ),
      )
      .map((assignment) => assignment.id);
    instance.update(
      before.id,
      {
        schema_version: 'haze.task.update.v3',
        ...expectation(before),
        kind: 'correction',
        passage: 'Change the selected town to Klang for the same interval.',
        scope: {
          location: 'Klang',
          period: {
            start: '2026-10-01T00:00:00Z',
            end: '2026-10-01T03:00:00Z',
          },
        },
        affected_assignment_ids: affected,
      },
      'scope-change',
    );
    const revised = instance.store.read(before.id, localTaskIdentity);
    expect(revised.result?.currency).toBe('stale');
    expect(revised.status).toBe('paused');
    instance.control(
      before.id,
      {
        schema_version: 'haze.task.control.v3',
        ...expectation(revised),
        action: 'resume',
      },
      'resume-corrected',
    );
    const after = await until(
      instance,
      before.id,
      (task) =>
        task.objective_revision === 2 &&
        ['completed', 'failed'].includes(task.status),
    );
    expect(
      after.status,
      JSON.stringify({
        error: after.error,
        work: after.assignments.map((a) => ({
          id: a.id,
          definition: a.definition_id,
          status: a.status,
          usability: a.usability,
        })),
        decisions: after.manager?.decisions.slice(-4),
      }),
    ).toBe('completed');
    expect(after.result?.covered_scope).toMatchObject({ location: 'Klang' });
    expect(after.result?.currency).toBe('current');
    const oldAnalysis = before.result!.work_products.find(
      (ref) =>
        instance.store.artifact(ref.id, localTaskIdentity).kind ===
        'pm25.analysis',
    )!;
    expect(
      after.result?.work_products.some((ref) => ref.id === oldAnalysis.id),
    ).toBe(false);
    expect(
      after.artifacts
        .filter(
          (entry) =>
            entry.objective_revision === 2 &&
            before.artifacts.some(
              (prior) => prior.artifact.id === entry.artifact.id,
            ),
        )
        .every((entry) => !entry.current),
    ).toBe(true);
    expect(
      after.manager?.plans.some((plan) => plan.objective_revision === 2),
    ).toBe(true);
  });
});
