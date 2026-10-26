import { createManagerSandboxRegistry } from './manager-sandbox.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import {
  parseManagerEvaluationArgs,
  selectManagerCases,
  restrictManagerEvaluationTools,
  checkManagerEvaluationIsolation,
  evaluationDefinitionIds,
  evaluationSpecialistRoles,
  evaluationLocalToolIds,
} from './manager-evaluation-support.mjs';

const args = process.argv.slice(2);
const casesBytes = await readFile(
  new URL(
    '../docs/orchestration/manager-evaluation-cases.json',
    import.meta.url,
  ),
);
const frozen = JSON.parse(casesBytes);
const options = parseManagerEvaluationArgs(args);
const cases = selectManagerCases(frozen.cases, options);
if (options.mode === 'list') {
  console.log(
    JSON.stringify(
      cases.map(({ id, objective }) => ({ id, objective })),
      null,
      2,
    ),
  );
  process.exit(0);
}
const live = options.mode === 'live';
const baseline = options.baselineRoot !== undefined;
const base = resolve(options.baselineRoot ?? options.buildRoot ?? '.');
const { TaskRuntime, localTaskIdentity } = await import(
  pathToFileURL(join(base, 'dist/tasks/runtime.js'))
);
const { ExecutionRegistry } = await import(
  pathToFileURL(join(base, 'dist/orchestration/ports.js'))
);
const { managerAgent } = await import(
  pathToFileURL(join(base, 'dist/agents/manager/index.js'))
);
const root = resolve(
  '.state/manager-evaluation',
  `${live ? 'live' : 'scripted'}-${baseline ? 'baseline' : 'supervised'}-${Date.now()}-${randomUUID()}`,
);
await mkdir(root, { recursive: true });
const receipt = {
  response_model: null,
  response_id: null,
  input_tokens: null,
  output_tokens: null,
};
const exact = ({ id, version, sha256 }) => ({ id, version, sha256 });
function scriptDecision(c, context) {
  if (baseline) {
    if (context.purpose === 'synthesis')
      return {
        answer: 'The registered evaluation finding is retained.',
        uncertainty: [],
      };
    if (c.id === 'clarification')
      return {
        id: randomUUID(),
        type: 'question',
        prompt: 'Which report should I summarize?',
      };
    if (
      [
        'direct',
        'conflicting-evidence',
        'unavailable',
        'injected-document',
      ].includes(c.id)
    )
      return {
        id: randomUUID(),
        type: 'respond',
        answer:
          c.id === 'conflicting-evidence'
            ? 'Reports disagree: 10 versus 12 [S1] [S2].'
            : c.sources
              ? 'The dataset has missing intervals [S1].'
              : 'An evidence gap is missing information required to support a finding.',
        uncertainty: [],
      };
    return {
      id: randomUUID(),
      type: 'delegate',
      capability: 'evaluation',
      assignments: plans(c),
    };
  }
  const d = (action) => ({
    id: randomUUID(),
    run_id: context.run_id,
    generation: context.generation,
    objective_revision: context.objective_revision,
    plan_revision: context.plan_revision,
    event_cursor: context.event_cursor,
    explanation: 'Follow the frozen scripted case and exact retained evidence.',
    references: [],
    interpretation: {
      scope: context.request.objective,
      deliverables: ['The frozen case outcome.'],
      assumptions: [],
      intended_use: 'Runtime evaluation with explicitly synthetic methods.',
      stopping_conditions: ['A supported result or exact question.'],
    },
    action,
  });
  const current = context.assignments.filter(
    (a) => !['cancelled', 'stale'].includes(a.status),
  );
  const sourceRefs = context.artifacts
    .filter((a) => a.current && a.kind === 'source.import')
    .map((a) => a.ref);
  const finish = (extra = {}) =>
    d({
      type: 'finalize',
      answer:
        c.id === 'conflicting-evidence'
          ? 'Reports disagree: 10 versus 12 [S1] [S2].'
          : c.sources
            ? 'The dataset has missing intervals [S1].'
            : 'The retained evaluation finding is supported within the synthetic test scope.',
      work_products: context.artifacts
        .filter(
          (a) =>
            a.current &&
            !context.assignments.some(
              (assignment) =>
                assignment.id === a.assignment_id &&
                assignment.role === 'EvidenceCritic',
            ) &&
            ['evaluation.finding', 'evaluation.reviewed'].includes(a.kind) &&
            !context.reviews.some(
              (r) => r.artifact.id === a.ref.id && r.verdict !== 'supported',
            ),
        )
        .map((a) => a.ref),
      sources: sourceRefs,
      uncertainty: [],
      unfinished: [],
      ...extra,
    });
  if (c.id === 'clarification')
    return d({ type: 'question', prompt: 'Which report should I summarize?' });
  if (['direct', 'conflicting-evidence', 'injected-document'].includes(c.id))
    return finish();
  if (c.id === 'unavailable')
    return finish({
      uncertainty: ['The remote observation capability is unavailable.'],
      unfinished: ['Provide an authorized available observation source.'],
    });
  if (
    !current.length ||
    context.plan_objective_revision !== context.objective_revision
  )
    return d({
      type: 'apply_plan',
      assignments: plans(c, context.objective_revision),
      retain_assignment_ids: [],
      reason: 'Execute the frozen custom plan.',
    });
  if (c.id === 'known-failure' && current.some((a) => a.status === 'failed'))
    return d({
      type: 'apply_plan',
      assignments: [
        item('alternative', 'eval.produce', [], {
          alternative: 'retained-source',
        }),
      ],
      retain_assignment_ids: [],
      reason:
        'The exact upstream unavailable error requires the authorized retained-source alternative.',
    });
  if (
    c.id === 'rejected-review' &&
    context.reviews.some((r) => r.verdict === 'rejected')
  )
    return d({
      type: 'apply_plan',
      assignments: [
        item('produce', 'eval.reviewed', [], { corrected: true }),
        item('review', 'eval.review', ['produce']),
      ],
      retain_assignment_ids: [],
      reason:
        'Repair the rejected corrected flag and independently review the new producer version.',
    });
  if (c.id === 'peer-request' && !context.peer_grants.length)
    return d({
      type: 'coordinate',
      participants: current.map((a) => ({
        assignment_id: a.id,
        revision: a.revision,
      })),
      purpose: 'evidence-clarification',
    });
  if (current.some((a) => ['queued', 'running', 'waiting'].includes(a.status)))
    return d({ type: 'wait', reason: 'Wait for material work products.' });
  return finish(
    c.id === 'partial'
      ? {
          unfinished: ['The upstream observation remains unavailable.'],
          uncertainty: ['The failed branch has not been repaired.'],
        }
      : {},
  );
}
function item(key, definition_id, depends_on = [], input = {}) {
  return {
    key,
    definition_id,
    brief: `Execute ${definition_id} for ${key}.`,
    depends_on,
    input,
  };
}
function plans(c, revision = 1) {
  switch (c.id) {
    case 'single':
      return [item('one', 'eval.produce')];
    case 'parallel':
      return [
        item('a', 'eval.produce', [], { branch: 'A' }),
        item('b', 'eval.produce', [], { branch: 'B' }),
      ];
    case 'known-failure':
      return [item('upstream', 'eval.fail')];
    case 'rejected-review':
      return [
        item('produce', 'eval.reviewed', [], { corrected: false }),
        item('review', 'eval.review', ['produce']),
      ];
    case 'peer-request':
      return [
        item('producer', 'eval.peer-producer'),
        item('reviewer', 'eval.peer-reviewer'),
      ];
    case 'partial':
      return [item('available', 'eval.produce'), item('missing', 'eval.fail')];
    case 'correction':
      return [
        item('selection', 'eval.slow', [], {
          region: revision > 1 ? 'new' : 'old',
        }),
      ];
    default:
      return [item('one', 'eval.produce')];
  }
}

const report = {
  schema_version: 'haze.manager.evaluation.v1',
  evaluator_version: 'manager-evaluator.v3',
  mode: live ? 'live' : 'scripted',
  implementation: baseline ? 'baseline' : 'supervised',
  baseline_commit: frozen.baseline_commit,
  cases_sha256: createHash('sha256').update(casesBytes).digest('hex'),
  started_at: new Date().toISOString(),
  isolation: {
    manager: {
      id: managerAgent.id,
      version: managerAgent.version,
      implementation: 'registered-manager-code',
    },
    manager_model: live
      ? 'configured-live-model'
      : 'deterministic-scripted-model',
    specialists: {
      implementation: 'deterministic-evaluation-stubs',
      roles: evaluationSpecialistRoles,
      assignment_definitions: evaluationDefinitionIds,
      model_calls_allowed: false,
      tool_calls_allowed: false,
    },
    runtime_local_tools_allowed: evaluationLocalToolIds,
    runtime_tool_policy:
      'Remove non-allowlisted tools and definition grants before task admission.',
    external_tools_allowed: false,
    state_directory: root,
    fresh_state_per_run: true,
    fresh_state_per_case: true,
    compiled_root: base,
  },
  cases: [],
};
for (const c of cases) {
  const started = Date.now();
  let runtime, task, executionRegistry;
  const record = {
    id: c.id,
    expected: c,
    started_at: new Date().toISOString(),
    passed: false,
  };
  try {
    const model = live
      ? undefined
      : {
          selection: { provider: 'scripted', model: 'frozen-manager-v1' },
          complete: (input) =>
            Promise.resolve(JSON.stringify(scriptDecision(c, input.context))),
          completeWithReceipt: (input) =>
            Promise.resolve({
              text: JSON.stringify(scriptDecision(c, input.context)),
              receipt,
            }),
        };
    executionRegistry = createManagerSandboxRegistry({
      ExecutionRegistry,
      managerAgent,
    });
    runtime = new TaskRuntime({
      stateDirectory: join(root, c.id),
      registry: executionRegistry,
      mode: live ? 'live' : 'replay',
      ...(model ? { model } : {}),
      env: process.env,
      limits: {
        deadline: new Date(Date.now() + 90000).toISOString(),
        max_model_calls: 20,
        max_tool_calls: 6,
        max_assignments: 16,
        max_artifacts: 64,
      },
    });
    record.runtime_registered_tool_ids_before_restriction = [
      ...executionRegistry.tools.keys(),
    ];
    record.excluded_runtime_tool_ids =
      restrictManagerEvaluationTools(executionRegistry);
    const refs = (c.sources ?? []).map((content, i) =>
      exact(
        runtime.importArtifact(
          {
            schema_version: 'haze.artifact.import.v3',
            filename: `report-${i + 1}.txt`,
            media_type: 'text/plain',
            content_base64: Buffer.from(content).toString('base64'),
          },
          randomUUID(),
        ),
      ),
    );
    const admitted = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: c.objective,
        context_refs: refs,
      },
      randomUUID(),
    );
    let corrected = false;
    for (;;) {
      task = runtime.store.read(admitted.task_id, localTaskIdentity);
      if (
        c.correction &&
        !corrected &&
        task.assignments.some(
          (a) => a.definition_id === 'eval.slow' && a.status === 'running',
        )
      ) {
        runtime.update(
          task.id,
          {
            schema_version: 'haze.task.update.v3',
            kind: 'correction',
            passage: c.correction,
            scope: { region: 'new' },
            expected_objective_revision: task.objective_revision,
            expected_run_id: task.current_run_id,
            expected_generation: task.generation,
            expected_state_revision: task.state_revision,
          },
          randomUUID(),
        );
        corrected = true;
      }
      if (!['queued', 'running'].includes(task.status)) break;
      if (Date.now() - started > 95000)
        throw new Error('Evaluation exceeded the unchanged admitted deadline.');
      await new Promise((done) => setTimeout(done, 20));
    }
    const specialists = task.assignments.filter((a) => a.role !== 'Manager');
    const events = runtime.store.events(task.id, localTaskIdentity).events;
    const artifacts = task.artifacts.map((a) =>
      runtime.store.artifact(a.artifact.id, localTaskIdentity),
    );
    record.task = task;
    record.events = events;
    record.artifacts = artifacts;
    record.attempts = runtime.store.attempts(task.id, localTaskIdentity);
    record.isolation = checkManagerEvaluationIsolation(task, record.attempts, [
      ...executionRegistry.tools.keys(),
    ]);
    record.observed = {
      status: task.status,
      completion: task.result?.completion,
      specialists: specialists.length,
      definitions: specialists.map((a) => a.definition_id),
      model_calls: task.usage.model_calls,
      tool_calls: task.usage.tool_calls,
      peer_messages: events.filter((e) => e.type === 'peer_message_sent')
        .length,
      latency_ms: Date.now() - started,
      provider_receipts: record.attempts
        .filter((a) => a.receipt)
        .map((a) => a.receipt),
    };
    record.passed =
      record.isolation.passed &&
      task.status === c.expected_status &&
      (c.max_specialists === undefined ||
        specialists.length <= c.max_specialists) &&
      (c.min_specialists === undefined ||
        specialists.length >= c.min_specialists) &&
      (!c.expected_definitions ||
        c.expected_definitions.every((id) =>
          specialists.some((a) => a.definition_id === id),
        )) &&
      (!c.expected_completion ||
        task.result?.completion === c.expected_completion) &&
      (!c.expected_objective_revision ||
        task.objective_revision === c.expected_objective_revision) &&
      (!c.expected_review ||
        task.result?.review.checks?.some(
          (check) => check.verdict === c.expected_review,
        )) &&
      (!c.expected_peer_messages ||
        record.observed.peer_messages >= c.expected_peer_messages) &&
      (c.answer_includes ?? []).every((t) => task.result?.answer.includes(t)) &&
      (c.answer_excludes ?? []).every((t) => !task.result?.answer.includes(t));
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    if (runtime && task) {
      record.task = runtime.store.read(task.id, localTaskIdentity);
      record.events = runtime.store.events(task.id, localTaskIdentity).events;
      record.artifacts = record.task.artifacts.map((entry) =>
        runtime.store.artifact(entry.artifact.id, localTaskIdentity),
      );
      record.attempts = runtime.store.attempts(task.id, localTaskIdentity);
      record.isolation = checkManagerEvaluationIsolation(
        record.task,
        record.attempts,
        [...executionRegistry.tools.keys()],
      );
    }
  } finally {
    if (runtime) await runtime.close();
  }
  if (
    c.id === 'unavailable' &&
    !['partial', 'blocked'].includes(record.task?.result?.completion)
  )
    record.passed = false;
  if (c.id === 'correction' && record.task?.result) {
    const selected = new Set(
      record.task.result.work_products.map((ref) => ref.id),
    );
    if (
      (record.artifacts ?? []).some(
        (artifact) =>
          selected.has(artifact.id) && artifact.content?.region === 'old',
      )
    )
      record.passed = false;
  }
  record.passed = Boolean(record.passed);
  record.latency_ms = Date.now() - started;
  report.cases.push(record);
  await writeFile(
    join(root, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      case: c.id,
      passed: record.passed,
      observed: record.observed,
      isolation: record.isolation,
      error: record.error,
      task_error: task?.error,
    }),
  );
}
report.finished_at = new Date().toISOString();
report.passed = report.cases.every((c) => c.passed);
report.summary = {
  total: report.cases.length,
  passed_cases: report.cases.filter((c) => c.passed).length,
  failed_cases: report.cases.filter((c) => !c.passed).length,
};
await writeFile(
  join(root, 'report.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    report: join(root, 'report.json'),
    passed: report.passed,
    ...report.summary,
  }),
);
process.exitCode = report.passed ? 0 : 1;
