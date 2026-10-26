import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const args = process.argv.slice(2);
if (!['--scripted', '--live'].includes(args[0]))
  throw new Error(
    'Usage: evaluate-manager.mjs --scripted|--live [--baseline ROOT] [--case ID]',
  );
const live = args[0] === '--live';
const baselineIndex = args.indexOf('--baseline');
const base =
  baselineIndex < 0 ? resolve('.') : resolve(args[baselineIndex + 1]);
const baseline = baselineIndex >= 0;
const caseIndex = args.indexOf('--case');
const casesBytes = await readFile(
  new URL(
    '../docs/orchestration/manager-evaluation-cases.json',
    import.meta.url,
  ),
);
const frozen = JSON.parse(casesBytes);
const cases = frozen.cases.filter(
  (c) => caseIndex < 0 || c.id === args[caseIndex + 1],
);
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
                context.definitions.some(
                  (definition) =>
                    definition.id === assignment.definition_id &&
                    definition.agent === 'EvidenceCritic',
                ),
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
function registry() {
  const r = new ExecutionRegistry().registerAgent(managerAgent);
  for (const id of ['HazeOps', 'WorkerShield', 'EvidenceCritic'])
    r.registerAgent({
      id,
      version: 'evaluation.v1',
      instructions: 'Use the registered deterministic implementation.',
    });
  r.registerCapability({
    card: {
      id: 'evaluation',
      version: '1',
      purpose:
        'Synthetic runtime evaluation methods. eval.produce retains a finding; eval.fail fails with an exact known unavailable error; eval.reviewed and eval.review exercise independent repair; eval.peer-* exercise clarification; eval.slow permits correction.',
      work_products: ['evaluation.finding'],
      required_tools: [],
      roles: ['HazeOps', 'EvidenceCritic'],
      readiness: 'implemented',
      limitations: [
        'Synthetic evaluation outputs; no environmental observations.',
      ],
    },
    matches: () => true,
    assignments: () => [
      item('one', 'eval.produce'),
      item('two', 'eval.produce'),
    ],
    peer_requirements: [
      {
        definitions: ['eval.peer-producer', 'eval.peer-reviewer'],
        purpose: 'evidence-clarification',
      },
    ],
    review_requirements: [
      {
        artifact_kind: 'evaluation.reviewed',
        review_definition_id: 'eval.review',
        producer_definition_ids: ['eval.reviewed'],
      },
    ],
    normalizeReview: (a) =>
      a.kind === 'evaluation.review'
        ? {
            verdict: a.content.verdict,
            artifacts: a.content.reviewed_artifacts,
            limitations: ['Synthetic independent review.'],
          }
        : undefined,
  });
  r.registerCapability({
    card: {
      id: 'eval.unavailable',
      version: '1',
      purpose: 'Remote observation requires unavailable permission.',
      work_products: [],
      required_tools: ['denied.observation'],
      roles: ['HazeOps'],
      readiness: 'specified',
      limitations: ['Missing source grant.'],
    },
    matches: () => false,
    assignments: () => [],
    availability: () => ({
      available: false,
      reasons: ['No authorized observation source is configured.'],
    }),
  });
  for (const id of [
    'eval.produce',
    'eval.fail',
    'eval.reviewed',
    'eval.review',
    'eval.peer-producer',
    'eval.peer-reviewer',
    'eval.slow',
  ])
    r.registerAssignment({
      id,
      version: '1',
      capability: 'evaluation',
      agent:
        id === 'eval.review' || id === 'eval.peer-reviewer'
          ? 'EvidenceCritic'
          : 'HazeOps',
      tools: [],
      instructions: `Registered ${id}.`,
      async execute(s) {
        if (id === 'eval.fail')
          throw new Error(
            'upstream_unavailable: the authorized upstream has no result; use retained-source instead.',
          );
        if (id === 'eval.slow')
          await new Promise((done) => setTimeout(done, 200));
        if (id === 'eval.review') {
          const producer = s.context.inputs.find(
            (a) => a.kind === 'evaluation.reviewed',
          );
          if (!producer) throw new Error('Missing exact producer revision.');
          const a = s.save('evaluation.review', {
            verdict: producer.content.corrected ? 'supported' : 'rejected',
            reviewed_artifacts: [exact(producer)],
          });
          return {
            status: 'completed',
            summary: producer.content.corrected
              ? 'Corrected finding supported.'
              : 'Objection: corrected must be true.',
            support: producer.content.corrected ? 'supported' : 'gap',
            uncertainty: [],
            outputs: [a],
          };
        }
        if (id.startsWith('eval.peer-')) {
          const peer = s.context.peers.find(
            (p) =>
              p.definition_id !== id &&
              p.definition_id.startsWith('eval.peer-'),
          );
          if (!peer)
            throw new Error('A Manager-granted peer channel is required.');
          const received = s.inbox().find((m) => m.sender === peer.id);
          if (id === 'eval.peer-producer' && !received) {
            s.message(
              peer.id,
              'evidence-clarification',
              'Clarify the exact evidence scope.',
            );
            return {
              status: 'waiting_peer',
              summary: 'Waiting for clarification.',
              support: 'partial',
              uncertainty: [],
              outputs: [],
            };
          }
          if (id === 'eval.peer-reviewer' && !received)
            return {
              status: 'waiting_peer',
              summary: 'Waiting for the producer question.',
              support: 'partial',
              uncertainty: [],
              outputs: [],
            };
          if (id === 'eval.peer-reviewer')
            s.message(
              peer.id,
              'evidence-clarification',
              'This is explicitly synthetic evidence.',
            );
        }
        const a = s.save(
          id === 'eval.reviewed' ? 'evaluation.reviewed' : 'evaluation.finding',
          { finding: 'A retained synthetic finding.', ...s.input },
        );
        return {
          status: 'completed',
          summary: 'A synthetic finding is retained; it is not an observation.',
          support: 'supported',
          uncertainty: [],
          outputs: [a],
        };
      },
    });
  return r;
}
const report = {
  schema_version: 'haze.manager.evaluation.v1',
  evaluator_version: 'manager-evaluator.v2',
  mode: live ? 'live' : 'scripted',
  implementation: baseline ? 'baseline' : 'supervised',
  baseline_commit: frozen.baseline_commit,
  cases_sha256: createHash('sha256').update(casesBytes).digest('hex'),
  started_at: new Date().toISOString(),
  cases: [],
};
for (const c of cases) {
  const started = Date.now();
  let runtime, task;
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
    runtime = new TaskRuntime({
      stateDirectory: join(root, c.id),
      registry: registry(),
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
      error: record.error,
      task_error: task?.error,
    }),
  );
}
report.finished_at = new Date().toISOString();
report.passed = report.cases.every((c) => c.passed);
await writeFile(
  join(root, 'report.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify({ report: join(root, 'report.json'), passed: report.passed }),
);
process.exitCode = report.passed ? 0 : 1;
