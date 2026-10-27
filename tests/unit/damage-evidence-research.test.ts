import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { managerAgent } from '../../app/agents/manager/index.js';
import { hazeOpsAgent } from '../../app/agents/hazeops/index.js';
import { ExecutionRegistry } from '../../app/orchestration/ports.js';
import type { AgentModel } from '../../app/adapters/agent-model.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import {
  EVIDENCE_RESEARCH_TOOL_IDS,
  evidenceResearchToolGranted,
} from '../../app/contracts/evidence-tools.js';
import { fetchTavilySearch } from '../../app/adapters/haze-sources/tavily.js';
import { createWebSearchTools } from '../../app/capabilities/evidence-collection/web-search.js';
import {
  createCapturedExcerptTools,
  createDamageEvidenceResearchAssignments,
  createDamageEvidenceResearchCapability,
} from '../../app/capabilities/damage-evidence-research/index.js';
import { digest } from '../../app/orchestration/specialist-graph.js';
import { createSpecialistActionContract } from '../../app/orchestration/action-contract.js';
import { webSearchQuerySchema } from '../../app/contracts/web-search.js';
import type { ArtifactRef } from '../../app/contracts/artifacts.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function registry() {
  const result = new ExecutionRegistry();
  result.registerAgent(managerAgent).registerAgent(hazeOpsAgent);
  result.registerCapability(createDamageEvidenceResearchCapability());
  for (const assignment of createDamageEvidenceResearchAssignments())
    result.registerAssignment(assignment);
  for (const tool of createWebSearchTools({ mode: 'fixture' }))
    result.registerTool(tool);
  result.registerStoreTools(createCapturedExcerptTools);
  // This test isolates discovery; the acquisition implementations have their own contract tests.
  for (const id of EVIDENCE_RESEARCH_TOOL_IDS.filter((id) =>
    id.startsWith('haze-damage-'),
  ))
    result.registerTool({
      id,
      version: 'isolated-test.v1',
      description: 'Unused isolated acquisition tool.',
      mode: 'fixture',
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: () => {
        throw new Error('Unexpected acquisition in discovery test.');
      },
    });
  return result;
}

describe('damage public-evidence discovery', () => {
  it('enforces the charged search quota at runtime and retains quota history across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-search-quota-'));
    let current: TaskRuntime | undefined;
    cleanups.push(async () => {
      await current?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const execution = registry();
    const original = execution.tools.get('haze-web-search')!;
    let providerCalls = 0;
    execution.tools.set(original.id, {
      ...original,
      execute: async (input, context) => {
        providerCalls++;
        return original.execute(input, context);
      },
    });
    const definition = execution.definitions.get(
      'damage-evidence-research.discover',
    )!;
    execution.definitions.set(definition.id, {
      ...definition,
      async execute(services) {
        const query = {
          schema_version: 'haze.websearch.query.v1',
          query: 'Malaysia public evidence',
        };
        const result = await services.tool('haze-web-search', query);
        const saved = services.save('websearch.capture', result);
        await services.tool('haze-web-search', query);
        return {
          status: 'completed',
          summary: 'Unexpected second retrieval.',
          support: 'partial',
          uncertainty: ['Synthetic test.'],
          outputs: [saved],
        };
      },
    });
    const model: AgentModel = {
      selection: { provider: 'scripted', model: 'unused-specialist' },
      complete: () =>
        Promise.reject(
          new Error('Deterministic quota test needs no specialist model.'),
        ),
    };
    current = new TaskRuntime({
      stateDirectory: directory,
      registry: execution,
      mode: 'fixture',
      model,
    });
    const admitted = current.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Check the bounded source quota.',
        scope: { capability: 'damage-evidence-research' },
      },
      'quota-test',
    );
    const deadline = Date.now() + 20_000;
    while (
      Date.now() < deadline &&
      !['failed', 'completed', 'waiting', 'paused'].includes(
        current.store.read(admitted.task_id, localTaskIdentity).status,
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const task = current.store.read(admitted.task_id, localTaskIdentity);
    const assignment = task.assignments.find(
      (entry) => entry.definition_id === definition.id,
    )!;
    expect(assignment.status).toBe('failed');
    expect(assignment.error?.message).toContain('registered tool call limit');
    expect(providerCalls).toBe(1);
    const attempts = current.store
      .attempts(task.id, localTaskIdentity)
      .filter((entry) => entry.kind === 'tool');
    expect(attempts.map(({ status }) => status)).toEqual([
      'completed',
      'failed',
    ]);
    await current.close();
    current = new TaskRuntime({
      stateDirectory: directory,
      registry: execution,
      mode: 'fixture',
      model,
    });
    expect(
      current.store
        .attempts(task.id, localTaskIdentity)
        .filter((entry) => entry.kind === 'tool'),
    ).toEqual(attempts);
  }, 30_000);
  it('requires exact retention before another paid retrieval after a successful declared capture', () => {
    const context = {
      tools: [{ id: 'haze-web-search' }],
      artifact_kinds: ['websearch.capture'],
      tool_results: [
        {
          action_id: 'search-1',
          status: 'completed',
          artifact_kind: 'websearch.capture',
          saved: false,
        },
      ],
    };
    const contract = createSpecialistActionContract(context);
    expect(contract.allowedActions).toEqual(['save_tool_result']);
    expect(() =>
      contract.schema.parse({
        id: 'search-2',
        type: 'tool',
        tool: 'haze-web-search',
        input: {},
      }),
    ).toThrow();
    expect(
      contract.schema.parse({
        id: 'save-1',
        type: 'save_tool_result',
        kind: 'websearch.capture',
        tool_action_id: 'search-1',
      }).type,
    ).toBe('save_tool_result');
    expect(
      createSpecialistActionContract({
        ...context,
        tool_results: [{ ...context.tool_results[0], saved: true }],
      }).allowedActions,
    ).toContain('finish');
  });
  it('requires explicit task and assignment research grants', () => {
    expect(
      evidenceResearchToolGranted(
        { scope: { capability: 'evidence-collection' } },
        'haze-web-search',
      ),
    ).toBe(false);
    expect(
      evidenceResearchToolGranted(
        { evidence_tools: ['haze-web-search'] },
        'haze-web-search',
      ),
    ).toBe(true);
    for (const tool of EVIDENCE_RESEARCH_TOOL_IDS)
      expect(
        evidenceResearchToolGranted(
          { scope: { capability: 'damage-evidence-research' } },
          tool,
        ),
      ).toBe(true);
    const definition = createDamageEvidenceResearchAssignments().find(
      (assignment) => assignment.id === 'damage-evidence-research.discover',
    )!;
    expect('execute' in definition).toBe(false);
    expect(definition.agent).toBe('HazeOps');
    expect(definition.tools).toContain('haze-web-search');
  });

  it('keeps usable bounded previews while withholding complete rows and originals', () => {
    const model_preview = {
      schema_version: 'haze.tool.preview.v1',
      notice: 'Untrusted evidence.',
      items: [
        {
          title: 'Source title',
          excerpt: 'A selected passage.',
          reference: 'sha256:abc:results[0]',
        },
      ],
    };
    const output = digest({
      rows: [{ huge: 'x'.repeat(2000) }],
      raw_response_base64: 'x'.repeat(2000),
      model_preview,
    }) as Record<string, unknown>;
    expect(output.model_preview).toEqual(model_preview);
    expect(output.rows).toEqual({ items: 1 });
    expect(output.raw_response_base64).toEqual({ characters: 2000 });
    expect(
      (
        digest({
          model_preview: {
            ...model_preview,
            items: [{ excerpt: 'x'.repeat(10001) }],
          },
        }) as Record<string, unknown>
      ).model_preview,
    ).toBeUndefined();
  });

  it('uses documented Tavily news/general dates, publication metadata, usage and Malay queries', async () => {
    let body: Record<string, unknown> = {};
    const fetch = vi.fn().mockImplementation((_url, init: RequestInit) => {
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer test-secret',
      );
      expect(init.body).not.toContain('test-secret');
      return Promise.resolve(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    await fetchTavilySearch(
      'test-secret',
      {
        query: 'jerebu Malaysia sumber rasmi',
        max_results: 2,
        topic: 'news',
        language: 'ms',
        start_date: '2026-10-01',
        end_date: '2026-10-27',
      },
      AbortSignal.timeout(10_000),
    );
    expect(body).toMatchObject({
      topic: 'news',
      language: 'ms',
      start_date: '2026-10-01',
      end_date: '2026-10-27',
      include_published_date: true,
      include_usage: true,
      filter_by_published_date: false,
      include_raw_content: false,
    });
    expect(body).not.toHaveProperty('days');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-27T12:00:00Z'));
    await fetchTavilySearch(
      'test-secret',
      { query: 'Malaysia haze', max_results: 1, recency_days: 7 },
      AbortSignal.timeout(10_000),
    );
    expect(body).toMatchObject({ topic: 'general', start_date: '2026-10-20' });
    fetch.mockResolvedValue(
      new Response(Buffer.alloc(524_289), { status: 200 }),
    );
    await expect(
      fetchTavilySearch(
        'test-secret',
        { query: 'Malaysia haze', max_results: 1 },
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toThrow(/exceeds 524288 bytes/u);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const invalid of [
      { start_date: '2026-10-27', end_date: '2026-10-01' },
      { recency_days: 7, time_range: 'week' },
      { start_date: '2026-02-30' },
    ])
      expect(() =>
        webSearchQuerySchema.parse({
          schema_version: 'haze.websearch.query.v1',
          query: 'Malaysia haze',
          ...invalid,
        }),
      ).toThrow();
  });

  it('runs Manager -> model-driven HazeOps -> retained search and selected excerpt, surviving restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-research-workflow-'));
    let current: TaskRuntime | undefined;
    cleanups.push(async () => {
      await current?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const previews: unknown[] = [];
    let calls = 0;
    const model: AgentModel = {
      selection: { provider: 'scripted', model: 'research-test' },
      complete(input) {
        const context = input.context as {
          tools?: { id: string }[];
          history?: {
            action?: { type: string; id: string; tool?: string };
            output?: unknown;
            artifact?: ArtifactRef;
          }[];
          outputs?: ArtifactRef[];
        };
        calls++;
        const history = context.history ?? [];
        const search = history.find(
          (entry) =>
            entry.action?.type === 'tool' &&
            entry.action.tool === 'haze-web-search',
        );
        const saved = history.find((entry) => entry.artifact)?.artifact;
        if (saved)
          expect(
            context.tools?.some((tool) => tool.id === 'haze-web-search'),
          ).toBe(false);
        const excerpt = history.find(
          (entry) =>
            entry.action?.type === 'tool' &&
            entry.action.tool === 'haze-captured-excerpt',
        );
        const excerptSaved =
          excerpt &&
          history.some(
            (entry) =>
              entry.action?.type === 'save_tool_result' &&
              'tool_action_id' in entry.action &&
              entry.action.tool_action_id === excerpt.action?.id,
          );
        const action = !search
          ? {
              id: `search-${calls}`,
              type: 'tool',
              tool: 'haze-web-search',
              input: {
                schema_version: 'haze.websearch.query.v1',
                query: 'Malaysia haze official historical evidence',
              },
            }
          : !saved
            ? {
                id: `save-${calls}`,
                type: 'save_tool_result',
                kind: 'websearch.capture',
                tool_action_id: search.action!.id,
              }
            : !excerpt
              ? {
                  id: `excerpt-${calls}`,
                  type: 'tool',
                  tool: 'haze-captured-excerpt',
                  input: { artifact: saved, result_index: 0 },
                }
              : !excerptSaved
                ? {
                    id: `save-excerpt-${calls}`,
                    type: 'save_tool_result',
                    kind: 'evidence.excerpt',
                    tool_action_id: excerpt.action!.id,
                  }
                : {
                    id: `finish-${calls}`,
                    type: 'finish',
                    summary:
                      'Retained synthetic discovery leads with explicit evidence gaps.',
                    support: 'partial',
                    uncertainty: [
                      'Fixture evidence supports no real historical effect.',
                    ],
                    outputs: [saved],
                  };
        if (search?.output) previews.push(search.output);
        return Promise.resolve(JSON.stringify(action));
      },
    };
    current = new TaskRuntime({
      stateDirectory: directory,
      registry: registry(),
      mode: 'fixture',
      model,
    });
    const admission = current.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Find historical Malaysian evidence.',
        scope: { capability: 'damage-evidence-research' },
      },
      'research-workflow',
    );
    const expires = Date.now() + 20_000;
    while (
      Date.now() < expires &&
      !['completed', 'failed', 'paused', 'waiting', 'timed_out'].includes(
        current.store.read(admission.task_id, localTaskIdentity).status,
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const task = current.store.read(admission.task_id, localTaskIdentity);
    expect(task.status).toBe('completed');
    expect(
      task.assignments.find((assignment) => assignment.role === 'HazeOps')
        ?.tools,
    ).toContain('haze-web-search');
    const ref = task.artifacts.find(
      (entry) =>
        current!.store.artifact(entry.artifact.id, localTaskIdentity).kind ===
        'websearch.capture',
    )?.artifact;
    expect(ref).toBeDefined();
    expect(JSON.stringify(previews)).toContain(
      'Synthetic fixture: regional haze advisory',
    );
    expect(JSON.stringify(previews)).toContain('sha256:');
    const original = current.store.artifact(ref!.id, localTaskIdentity, ref);
    await current.close();
    current = new TaskRuntime({
      stateDirectory: directory,
      registry: registry(),
      mode: 'fixture',
      model,
    });
    expect(current.store.artifact(ref!.id, localTaskIdentity, ref)).toEqual(
      original,
    );
    expect(
      current.store.read(admission.task_id, localTaskIdentity).status,
    ).toBe('completed');
  }, 30_000);
});
