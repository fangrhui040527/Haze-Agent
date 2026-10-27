import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { describe, expect, it } from 'vitest';
import type { Artifact } from '../../app/contracts/artifacts.js';
import { TaskError } from '../../app/contracts/tasks.js';
import {
  createPm25Assignments,
  createPm25Tools,
  PM25_CHECK_ID,
  PM25_COVERAGE_ID,
} from '../../app/capabilities/pm25/index.js';
import {
  EvidenceSourceError,
  PM25_SOURCE_ID,
  type EvidenceScope,
} from '../../app/capabilities/pm25/evidence.js';
import { createFixtureCapture } from '../../app/capabilities/pm25/fixtures.js';
import {
  createSpecialistGraph,
  invokeSpecialistGraph,
  type SpecialistGraphHooks,
} from '../../app/orchestration/specialist-graph.js';
import type {
  AgentExecutionServices,
  AssignmentServices,
  ToolDefinition,
} from '../../app/orchestration/ports.js';
import { createExecutionRegistry } from '../../app/composition.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';

const scope: EvidenceScope = {
  location: 'Fixture Town',
  period: {
    start: '2026-10-01T00:00:00Z',
    end: '2026-10-01T03:00:00Z',
  },
};
const definitions = createPm25Assignments();
const definition = (id: string) => definitions.find((item) => item.id === id)!;

function services(
  input: unknown = scope,
  options: { inputs?: Artifact[]; tools?: ToolDefinition[] } = {},
) {
  const saved: Artifact[] = [];
  const calls: { id: string; input: unknown; output: unknown }[] = [];
  const questions: string[] = [];
  const tools = options.tools ?? createPm25Tools({ mode: 'fixture' });
  const api: AssignmentServices = {
    input,
    context: {
      taskId: randomUUID(),
      runId: randomUUID(),
      assignmentId: randomUUID(),
      assignmentRevision: 1,
      objectiveRevision: 1,
      generation: 1,
      identity: { principal: 'test-user', workspace: 'test-workspace' },
      deadline: new Date(Date.now() + 10_000).toISOString(),
      signal: new AbortController().signal,
      inputs: options.inputs ?? [],
      outputs: [],
      peers: [],
    },
    async tool(id, input) {
      const tool = tools.find((item) => item.id === id);
      if (!tool) throw new Error(`Unexpected tool ${id}`);
      const output = tool.outputSchema.parse(
        await tool.execute(tool.inputSchema.parse(input), api.context),
      );
      calls.push({ id, input, output });
      return output;
    },
    save(kind, content, metadata) {
      const artifact = {
        id: randomUUID(),
        version: 1,
        sha256: createHash('sha256')
          .update(JSON.stringify(content))
          .digest('hex'),
        assignment_id: api.context.assignmentId,
        kind,
        content,
        evidence_origin: metadata?.evidence_origin ?? 'derived',
      } as Artifact;
      saved.push(artifact);
      api.context.outputs.push(artifact);
      return artifact;
    },
    question(prompt) {
      questions.push(prompt);
    },
    message() {
      throw new Error('The fixed PM2.5 sequence does not message a peer.');
    },
    inbox: () => [],
    read() {
      throw new Error('Only pinned inputs are used.');
    },
  };
  return { api, saved, calls, questions };
}

describe('deterministic PM2.5 execution', () => {
  it('completes the registered fixture task with three method calls and zero specialist model calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-pm25-execution-'));
    const child = relative(resolve(tmpdir()), resolve(directory));
    if (!child || child.startsWith('..'))
      throw new Error('Unsafe test cleanup.');
    const runtime = new TaskRuntime({
      stateDirectory: directory,
      registry: createExecutionRegistry({ mode: 'fixture' }),
      mode: 'fixture',
      model: {
        selection: { provider: 'test', model: 'must-not-be-called' },
        complete: () => {
          throw new Error(
            'The fixed PM2.5 workflow must not enter a model loop.',
          );
        },
      },
    });
    try {
      const admission = runtime.admit(
        {
          schema_version: 'haze.task.request.v3',
          objective: 'Investigate PM2.5.',
          scope,
        },
        'deterministic-pm25',
      );
      const deadline = Date.now() + 20_000;
      let task = runtime.store.read(admission.task_id, localTaskIdentity);
      while (
        !['completed', 'failed', 'paused', 'timed_out'].includes(task.status) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        task = runtime.store.read(admission.task_id, localTaskIdentity);
      }
      expect(task.status, task.error?.message).toBe('completed');
      expect(task.usage).toMatchObject({ tool_calls: 3, model_calls: 0 });
      for (const id of ['pm25.retrieve', 'pm25.analyze', 'pm25.check']) {
        const assignment = task.assignments.find(
          (item) => item.definition_id === id,
        );
        expect(assignment).toMatchObject({
          status: 'completed',
          definition_version: '5',
          usage: { tool_calls: 1, model_calls: 0 },
        });
        expect(assignment!.outputs.length).toBeGreaterThan(0);
      }
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('retrieves, persists, analyzes and independently checks exact method outputs without a model loop', async () => {
    const retrieval = services();
    const selected = await definition('pm25.retrieve').execute!(retrieval.api);
    expect(selected).toMatchObject({
      status: 'completed',
      support: 'supported',
    });
    expect(retrieval.calls.map((call) => call.id)).toEqual([PM25_SOURCE_ID]);
    expect(retrieval.calls[0]!.input).toEqual(scope);
    const capture = retrieval.saved[0]!;
    expect(capture.content).toBe(retrieval.calls[0]!.output);
    expect(capture.content).toEqual(createFixtureCapture(scope));
    expect(capture.evidence_origin).toBe('synthetic_fixture');

    const producer = services(scope, { inputs: [capture] });
    const analyzed = await definition('pm25.analyze').execute!(producer.api);
    expect(analyzed).toMatchObject({
      status: 'completed',
      support: 'supported',
    });
    expect(producer.calls.map((call) => call.id)).toEqual([PM25_COVERAGE_ID]);
    expect(producer.calls[0]!.input).toEqual({ scope });
    const analysis = producer.saved[0]!;
    expect(analysis.content).toBe(producer.calls[0]!.output);

    const reviewer = services(scope, { inputs: [capture, analysis] });
    const checked = await definition('pm25.check').execute!(reviewer.api);
    expect(checked).toMatchObject({
      status: 'completed',
      support: 'supported',
    });
    expect(reviewer.calls.map((call) => call.id)).toEqual([PM25_CHECK_ID]);
    expect(reviewer.saved[0]!.content).toBe(reviewer.calls[0]!.output);
    expect(reviewer.saved[0]!.content).toMatchObject({
      valid: true,
      verdict: 'supported',
      reviewed_artifacts: [capture, analysis].map(
        ({ id, version, sha256 }) => ({
          id,
          version,
          sha256,
        }),
      ),
    });
  });

  it('retains externally retrieved capture bytes and provenance', async () => {
    const capture = {
      ...createFixtureCapture(scope),
      mode: 'live' as const,
      evidence_origin: 'modeled' as const,
    };
    let retrieved = 0;
    const test = services(scope, {
      tools: createPm25Tools({
        mode: 'live',
        source: {
          id: PM25_SOURCE_ID,
          retrieve: () => {
            retrieved++;
            return Promise.resolve(capture);
          },
        },
      }),
    });
    await definition('pm25.retrieve').execute!(test.api);
    expect(retrieved).toBe(1);
    expect(test.saved[0]!.content).toEqual(capture);
    expect(test.saved[0]!.evidence_origin).toBe('external_source');
  });

  it.each([
    { needs_scope: true },
    { ...scope, period: { start: scope.period.end, end: scope.period.start } },
    { ...scope, location: '' },
  ])(
    'asks once for an invalid or unresolved admitted scope: %j',
    async (input) => {
      const test = services(input);
      const output = await definition('pm25.retrieve').execute!(test.api);
      expect(output).toMatchObject({
        status: 'waiting_human',
        support: 'gap',
        outputs: [],
      });
      expect(test.questions).toHaveLength(1);
      expect(test.calls).toEqual([]);
      expect(test.saved).toEqual([]);
    },
  );

  it('finishes a known unavailable source as a gap without substituting evidence', async () => {
    const test = services(scope, {
      tools: createPm25Tools({
        mode: 'live',
        source: {
          id: PM25_SOURCE_ID,
          retrieve: () =>
            Promise.reject(
              new EvidenceSourceError('No configured source.', 'unavailable'),
            ),
        },
      }),
    });
    expect(await definition('pm25.retrieve').execute!(test.api)).toMatchObject({
      status: 'completed',
      support: 'gap',
      outputs: [],
    });
    expect(test.saved).toEqual([]);
  });

  it('propagates unknown outcomes and malformed evidence without manufacturing a gap or capture', async () => {
    const unknown = new EvidenceSourceError(
      'Connection lost.',
      'unavailable',
      'unknown',
    );
    const test = services(scope, {
      tools: createPm25Tools({
        mode: 'live',
        source: {
          id: PM25_SOURCE_ID,
          retrieve: () => Promise.reject(unknown),
        },
      }),
    });
    await expect(definition('pm25.retrieve').execute!(test.api)).rejects.toBe(
      unknown,
    );
    const taggedUnknown = Object.assign(
      new TaskError(503, 'pm25_source_unavailable', 'No conclusive receipt.'),
      { outcome: 'unknown' as const },
    );
    test.api.tool = () => Promise.reject(taggedUnknown);
    await expect(definition('pm25.retrieve').execute!(test.api)).rejects.toBe(
      taggedUnknown,
    );
    test.api.tool = () => Promise.resolve({ rows: [] });
    await expect(
      definition('pm25.retrieve').execute!(test.api),
    ).rejects.toThrow();
    expect(test.saved).toEqual([]);
  });

  it('reconstructs a recorded unavailable-source failure as the same gap without querying the source again', async () => {
    let sourceCalls = 0;
    const test = services(scope, {
      tools: createPm25Tools({
        mode: 'live',
        source: {
          id: PM25_SOURCE_ID,
          retrieve: () => {
            sourceCalls++;
            return Promise.reject(
              new EvidenceSourceError(
                'Source is not configured.',
                'unavailable',
              ),
            );
          },
        },
      }),
    });
    const api: AgentExecutionServices = {
      ...test.api,
      brief: 'Retrieve the admitted selection.',
      instructions: definition('pm25.retrieve').instructions,
      maxTurns: 8,
      history: [],
      toolCards: [],
      model: () => {
        throw new Error('No model is needed to resolve a known source gap.');
      },
      accept: () => false,
      reject: () => {},
    };
    const failures = new Map<string, { code: string; error: string }>();
    let completions = 0;
    const hooks: SpecialistGraphHooks = {
      services: (key) => ({
        ...api,
        async tool(id, input) {
          const persisted = failures.get(key);
          // remoteOperation reconstructs failed receipts as TaskError using
          // only the serialized code and message; the original class is gone.
          if (persisted)
            throw new TaskError(502, persisted.code, persisted.error);
          try {
            return await test.api.tool(id, input);
          } catch (error) {
            if (!(error instanceof TaskError)) throw error;
            expect(error.code).toBe('pm25_source_unavailable');
            failures.set(
              key,
              JSON.parse(
                JSON.stringify({ code: error.code, error: error.message }),
              ) as {
                code: string;
                error: string;
              },
            );
            throw new Error('crash after durable unavailable receipt', {
              cause: error,
            });
          }
        },
      }),
      execute: (api) => definition('pm25.retrieve').execute!(api),
      park: () => {},
      complete: () => {
        completions++;
      },
    };
    const saver = new MemorySaver();
    const run = () =>
      invokeSpecialistGraph(createSpecialistGraph(saver, hooks), api.context, {
        signal: api.context.signal,
      });
    await expect(run()).rejects.toThrow(
      'crash after durable unavailable receipt',
    );
    expect(sourceCalls).toBe(1);
    const recovered = await run();
    expect(recovered.output).toMatchObject({
      status: 'completed',
      support: 'gap',
      outputs: [],
    });
    expect(sourceCalls).toBe(1);
    expect(test.saved).toEqual([]);
    expect(completions).toBe(1);
  });

  it('withholds analysis and independent review when their exact prerequisites are missing', async () => {
    for (const id of ['pm25.analyze', 'pm25.check']) {
      const test = services();
      expect(await definition(id).execute!(test.api)).toMatchObject({
        support: 'gap',
        outputs: [],
      });
      expect(test.calls).toEqual([]);
      expect(test.saved).toEqual([]);
    }
  });

  it('keeps partial coverage and a rejected independent check truthful', async () => {
    const capture = createFixtureCapture(scope);
    capture.rows[1]!.value = null;
    const raw = JSON.parse(capture.raw) as { data: { pm25: number | null }[] };
    raw.data[1]!.pm25 = null;
    capture.raw = JSON.stringify(raw);
    const selection = services();
    const captureArtifact = selection.api.save('pm25.capture', capture);
    const producer = services(scope, { inputs: [captureArtifact] });
    const output = await definition('pm25.analyze').execute!(producer.api);
    expect(output.support).toBe('partial');
    expect(
      output.uncertainty.some((item) => item.includes('missing span')),
    ).toBe(true);
    const analysis = producer.saved[0]!;
    (
      analysis.content as { coverage: { row_count: number } }
    ).coverage.row_count = 999;
    const reviewer = services(scope, { inputs: [captureArtifact, analysis] });
    const checked = await definition('pm25.check').execute!(reviewer.api);
    expect(checked.support).toBe('gap');
    expect(reviewer.saved[0]!.content).toMatchObject({
      valid: false,
      verdict: 'rejected',
    });
  });

  it('refuses producer self-review before saving a verdict', async () => {
    const selected = services();
    await definition('pm25.retrieve').execute!(selected.api);
    const producer = services(scope, { inputs: selected.saved });
    await definition('pm25.analyze').execute!(producer.api);
    const reviewer = services(scope, {
      inputs: [...selected.saved, ...producer.saved],
    });
    reviewer.api.context.assignmentId = producer.api.context.assignmentId;
    await expect(
      definition('pm25.check').execute!(reviewer.api),
    ).rejects.toThrow('cannot independently check');
    expect(reviewer.saved).toEqual([]);
  });

  it('reconstructs a retrieval graph after a durable save without refetching or duplicating the capture', async () => {
    const test = services();
    const api: AgentExecutionServices = {
      ...test.api,
      brief: 'Retrieve the admitted selection.',
      instructions: definition('pm25.retrieve').instructions,
      maxTurns: 8,
      history: [],
      toolCards: [],
      model: () => {
        throw new Error(
          'A model loop must not run for deterministic retrieval.',
        );
      },
      accept: () => {
        throw new Error('No model response is expected.');
      },
      reject: () => {},
    };
    const receipts = new Map<string, unknown>();
    let crashAfterSave = true;
    let completions = 0;
    const hooks: SpecialistGraphHooks = {
      services: (key) => ({
        ...api,
        async tool(id, input) {
          if (receipts.has(key)) return receipts.get(key);
          const result = await test.api.tool(id, input);
          receipts.set(key, result);
          return result;
        },
        save(kind, content, metadata) {
          if (receipts.has(key)) return receipts.get(key) as Artifact;
          const artifact = test.api.save(kind, content, metadata);
          receipts.set(key, artifact);
          if (crashAfterSave) {
            crashAfterSave = false;
            throw new Error('crash after durable capture');
          }
          return artifact;
        },
      }),
      execute: (api) => definition('pm25.retrieve').execute!(api),
      park: () => {},
      complete: () => {
        completions++;
      },
    };
    const saver = new MemorySaver();
    const run = () =>
      invokeSpecialistGraph(createSpecialistGraph(saver, hooks), api.context, {
        signal: api.context.signal,
      });
    await expect(run()).rejects.toThrow('crash after durable capture');
    expect(test.calls).toHaveLength(1);
    expect(test.saved).toHaveLength(1);
    const result = await run();
    expect(result.output).toMatchObject({
      status: 'completed',
      support: 'supported',
    });
    expect(result.output!.outputs).toEqual([
      {
        id: test.saved[0]!.id,
        version: test.saved[0]!.version,
        sha256: test.saved[0]!.sha256,
      },
    ]);
    expect(test.calls).toHaveLength(1);
    expect(test.saved).toHaveLength(1);
    expect(completions).toBe(1);
  });
});
