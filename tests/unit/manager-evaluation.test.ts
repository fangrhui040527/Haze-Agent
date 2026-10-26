import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface EvaluationOptions {
  mode: 'scripted' | 'live' | 'list';
  baselineRoot?: string;
  buildRoot?: string;
  caseId?: string;
}
interface EvaluationCase {
  id: string;
  objective: string;
}
interface IsolationTask {
  assignments: { id: string; role: string; definition_id: string }[];
}
interface IsolationAttempt {
  id: string;
  assignment_id: string;
  kind: 'model' | 'tool';
  details?: { tool: string };
}
interface IsolationResult {
  passed: boolean;
  violations: string[];
  manager_model_calls: number;
  specialist_model_calls: number;
  specialist_tool_calls: number;
  registered_tool_ids: string[];
  observed_tool_ids: string[];
}
interface IsolationRegistry {
  tools: Map<string, { id: string }>;
  definitions: Map<string, { tools: string[] }>;
}
const supportUrl = new URL(
  '../../scripts/manager-evaluation-support.mjs',
  import.meta.url,
).href;
const {
  parseManagerEvaluationArgs,
  selectManagerCases,
  restrictManagerEvaluationTools,
  checkManagerEvaluationIsolation,
} = (await import(supportUrl)) as {
  parseManagerEvaluationArgs: (args: string[]) => EvaluationOptions;
  selectManagerCases: (
    cases: EvaluationCase[],
    options: EvaluationOptions,
  ) => EvaluationCase[];
  restrictManagerEvaluationTools: (registry: IsolationRegistry) => string[];
  checkManagerEvaluationIsolation: (
    task: IsolationTask,
    attempts: IsolationAttempt[],
    registeredTools: string[],
  ) => IsolationResult;
};
const cases: EvaluationCase[] = [
  { id: 'direct', objective: 'Answer directly.' },
  { id: 'single', objective: 'Use one synthetic specialist.' },
];
const evaluator = fileURLToPath(
  new URL('../../scripts/evaluate-manager.mjs', import.meta.url),
);

describe('Manager evaluation invocation', () => {
  it('retains scripted/live baseline compatibility and selects a named case', () => {
    const options = parseManagerEvaluationArgs([
      '--live',
      '--baseline',
      'baseline-root',
      '--case',
      'single',
    ]);
    expect(options).toMatchObject({
      mode: 'live',
      baselineRoot: 'baseline-root',
      caseId: 'single',
    });
    expect(selectManagerCases(cases, options)).toEqual([cases[1]]);
    expect(
      selectManagerCases(cases, parseManagerEvaluationArgs(['--scripted'])),
    ).toEqual(cases);
  });

  it('supports a supervised compiled root without selecting baseline semantics', () => {
    const options = parseManagerEvaluationArgs([
      '--scripted',
      '--build-root',
      'isolated-build',
    ]);
    expect(options.buildRoot).toBe('isolated-build');
    expect(options.baselineRoot).toBeUndefined();
  });

  it.each([
    [],
    ['--case', 'direct'],
    ['--unknown'],
    ['--scripted', '--live'],
    ['--scripted', '--unknown'],
    ['--scripted', 'extra'],
    ['--scripted', '--case'],
    ['--scripted', '--case', '--baseline', 'root'],
    ['--scripted', '--baseline'],
    ['--scripted', '--build-root'],
    ['--live', '--case', 'direct', '--case', 'single'],
    ['--scripted', '--baseline', 'a', '--build-root', 'b'],
    ['--list', '--case', 'direct'],
  ])('rejects invalid invocation %j', (...args) => {
    expect(() => parseManagerEvaluationArgs(args)).toThrow();
  });

  it('rejects unknown case IDs and empty case sets instead of passing vacuously', () => {
    expect(() =>
      selectManagerCases(
        cases,
        parseManagerEvaluationArgs(['--scripted', '--case', 'typo']),
      ),
    ).toThrow('Unknown Manager evaluation case: typo');
    expect(() =>
      selectManagerCases([], parseManagerEvaluationArgs(['--scripted'])),
    ).toThrow('No Manager evaluation cases');
  });

  it('lists cases and rejects unknown IDs with no compiled runtime, provider or state directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-manager-cli-'));
    try {
      const listed = spawnSync(process.execPath, [evaluator, '--list'], {
        cwd: directory,
        env: {},
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(listed.error).toBeUndefined();
      expect(listed.status).toBe(0);
      const listedCases = JSON.parse(listed.stdout) as EvaluationCase[];
      expect(listedCases.find((c) => c.id === 'direct')?.objective).toBeTypeOf(
        'string',
      );
      const rejected = spawnSync(
        process.execPath,
        [evaluator, '--scripted', '--case', 'typo'],
        { cwd: directory, env: {}, encoding: 'utf8', timeout: 5000 },
      );
      expect(rejected.error).toBeUndefined();
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'Unknown Manager evaluation case: typo',
      );
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('Manager evaluation isolation evidence', () => {
  const task: IsolationTask = {
    assignments: [
      {
        id: 'manager',
        role: 'Manager',
        definition_id: 'core.manager.coordinator',
      },
      { id: 'stub', role: 'HazeOps', definition_id: 'eval.produce' },
    ],
  };
  const modelAttempt: IsolationAttempt = {
    id: 'model',
    assignment_id: 'manager',
    kind: 'model',
  };

  it('removes runtime-added domain tools and their definition grants before admission', () => {
    const registry: IsolationRegistry = {
      tools: new Map(
        [
          'world.lookup',
          'world.context',
          'world.lineage',
          'damage.world-inputs',
        ].map((id) => [id, { id }]),
      ),
      definitions: new Map([
        ['eval.produce', { tools: ['world.lookup', 'damage.world-inputs'] }],
        ['eval.review', { tools: ['world.context', 'world.lineage'] }],
      ]),
    };
    expect(restrictManagerEvaluationTools(registry)).toEqual([
      'damage.world-inputs',
    ]);
    expect([...registry.tools.keys()]).toEqual([
      'world.lookup',
      'world.context',
      'world.lineage',
    ]);
    expect([...registry.definitions.keys()]).toEqual([
      'eval.produce',
      'eval.review',
    ]);
    expect(registry.definitions.get('eval.produce')?.tools).toEqual([
      'world.lookup',
    ]);
    expect(registry.definitions.get('eval.review')?.tools).toEqual([
      'world.context',
      'world.lineage',
    ]);
    expect(restrictManagerEvaluationTools(registry)).toEqual([]);
  });

  it('also strips unregistered domain-tool grants from synthetic definitions', () => {
    const registry: IsolationRegistry = {
      tools: new Map(),
      definitions: new Map([
        ['eval.produce', { tools: ['damage.world-inputs'] }],
      ]),
    };
    expect(restrictManagerEvaluationTools(registry)).toEqual([]);
    expect(registry.definitions.get('eval.produce')?.tools).toEqual([]);
  });

  it('accepts deterministic specialists and records only Manager model calls', () => {
    expect(
      checkManagerEvaluationIsolation(task, [modelAttempt], []),
    ).toMatchObject({
      passed: true,
      violations: [],
      manager_model_calls: 1,
      specialist_model_calls: 0,
      specialist_tool_calls: 0,
    });
  });

  it('truthfully permits runtime-local world tools for the Manager', () => {
    const result = checkManagerEvaluationIsolation(
      task,
      [
        modelAttempt,
        {
          id: 'local',
          assignment_id: 'manager',
          kind: 'tool',
          details: { tool: 'world.lookup' },
        },
      ],
      ['world.lookup', 'world.context', 'world.lineage'],
    );
    expect(result.passed).toBe(true);
    expect(result.observed_tool_ids).toEqual(['world.lookup']);
    expect(result.registered_tool_ids).toHaveLength(3);
  });

  it('rejects production specialist work even when it has an expected role', () => {
    const result = checkManagerEvaluationIsolation(
      {
        assignments: [
          ...task.assignments,
          { id: 'real', role: 'HazeOps', definition_id: 'pm25.fetch' },
        ],
      },
      [],
      [],
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      'Non-evaluation specialist: pm25.fetch',
    );
  });

  it('rejects specialist model/tool calls and external tool registrations or attempts', () => {
    const result = checkManagerEvaluationIsolation(
      task,
      [
        { id: 'unexpected-model', assignment_id: 'stub', kind: 'model' },
        {
          id: 'unexpected-tool',
          assignment_id: 'stub',
          kind: 'tool',
          details: { tool: 'external.fetch' },
        },
      ],
      ['external.fetch'],
    );
    expect(result.passed).toBe(false);
    expect(result.specialist_model_calls).toBe(1);
    expect(result.specialist_tool_calls).toBe(1);
    expect(result.violations).toContain(
      'Non-local tool registered: external.fetch',
    );
    expect(result.violations).toContain(
      'Non-local tool attempt: external.fetch',
    );
  });

  it('rejects model attempts that cannot be attributed to a known assignment', () => {
    const result = checkManagerEvaluationIsolation(
      task,
      [{ ...modelAttempt, assignment_id: 'unknown' }],
      [],
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      'Attempt has an unknown assignment: model',
    );
  });
});
