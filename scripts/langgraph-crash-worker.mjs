import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskRuntime, localTaskIdentity } from '../dist/tasks/runtime.js';
import { ExecutionRegistry } from '../dist/orchestration/ports.js';
import { managerAgent } from '../dist/agents/manager/index.js';

// A separate OS process is required: throwing would exercise orderly unwinding,
// not a process loss between an application commit and the graph checkpoint.
const [directory, stage, phase] = process.argv.slice(2);
if (
  !process.send ||
  !directory ||
  !stage ||
  !['crash', 'recover'].includes(phase)
)
  throw new Error(
    'This worker must be started by verify-langgraph-crashes.mjs.',
  );
const callsPath = join(directory, 'remote-calls.jsonl');
function barrier(details = {}) {
  writeFileSync(
    join(directory, 'crash-barrier.json'),
    JSON.stringify({ stage, pid: process.pid, ...details }),
  );
  // The parent kills this process after reading the durable test barrier.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const registry = new ExecutionRegistry()
  .registerAgent(managerAgent)
  .registerAgent({
    id: 'HazeOps',
    version: 'crash-test.v1',
    instructions: 'Produce the registered deterministic finding.',
  })
  .registerCapability({
    card: {
      id: 'crash-test',
      version: '1',
      purpose: 'Exercise application receipt and checkpoint crash boundaries.',
      work_products: ['crash.finding'],
      required_tools: [],
      roles: ['HazeOps'],
      readiness: 'implemented',
      limitations: ['Synthetic runtime verification only.'],
    },
    matches: () => true,
    assignments: () => [],
  })
  .registerAssignment({
    id: 'crash.produce',
    version: '1',
    capability: 'crash-test',
    agent: 'HazeOps',
    tools: [],
    instructions: 'Save exactly one immutable finding.',
    execute(services) {
      const finding = services.save('crash.finding', { value: 7 });
      return {
        status: 'completed',
        summary: 'The deterministic finding was retained.',
        support: 'supported',
        uncertainty: [],
        outputs: [finding],
      };
    },
  });
const model = {
  selection: { provider: 'scripted', model: 'crash-boundary.v1' },
  async complete(input) {
    const context = input.context;
    appendFileSync(
      callsPath,
      `${JSON.stringify({ role: input.role, run_id: context.run_id, generation: context.generation })}\n`,
    );
    if (phase === 'crash' && stage === 'during-remote')
      barrier({ run_id: context.run_id });
    const products = context.artifacts
      .filter(
        (artifact) => artifact.current && artifact.kind === 'crash.finding',
      )
      .map((artifact) => artifact.ref);
    const local = stage === 'after-local-effect';
    const assignment = context.assignments.find(
      (item) => item.definition_id === 'crash.produce',
    );
    const action =
      local && !assignment
        ? {
            type: 'apply_plan',
            assignments: [
              {
                key: 'finding',
                definition_id: 'crash.produce',
                brief: 'Retain the deterministic finding.',
                depends_on: [],
              },
            ],
            retain_assignment_ids: [],
            reason: 'Exercise one deterministic specialist effect.',
          }
        : local && assignment.status !== 'completed'
          ? { type: 'wait', reason: 'Wait for the independent assignment.' }
          : {
              type: 'finalize',
              answer: 'The crash recovery verification completed.',
              work_products: products,
              sources: [],
              uncertainty: [],
              unfinished: [],
            };
    return JSON.stringify({
      id: randomUUID(),
      run_id: context.run_id,
      generation: context.generation,
      objective_revision: context.objective_revision,
      plan_revision: context.plan_revision,
      event_cursor: context.event_cursor,
      explanation: 'This scripted decision tests runtime durability only.',
      references: [],
      ...(!context.interpretation
        ? {
            interpretation: {
              scope: context.request.objective,
              deliverables: ['A verified final response.'],
              assumptions: [],
              intended_use: 'Synthetic crash verification.',
              stopping_conditions: ['Retain the final response.'],
            },
          }
        : {}),
      action,
    });
  },
};
const runtime = new TaskRuntime({
  stateDirectory: directory,
  registry,
  mode: 'live',
  model,
  limits: { max_model_calls: 20 },
});
if (phase === 'crash') {
  const graph = runtime.store.graph;
  if (stage === 'before-dispatch') {
    const original = graph.prepare.bind(graph);
    graph.prepare = (...args) => {
      const operation = original(...args);
      if (operation.kind === 'model')
        barrier({ operation_id: operation.id, status: operation.status });
      return operation;
    };
  }
  if (stage === 'after-receipt') {
    const original = graph.complete.bind(graph);
    const transaction = graph.transaction.bind(graph);
    let transactionDepth = 0;
    let completed;
    graph.transaction = (...args) => {
      transactionDepth++;
      let result;
      try {
        result = transaction(...args);
      } finally {
        transactionDepth--;
      }
      if (completed && transactionDepth === 0)
        barrier({ operation_id: completed.id, status: completed.status });
      return result;
    };
    graph.complete = (...args) => {
      const operation = original(...args);
      if (operation.kind === 'model') {
        completed = operation;
        if (transactionDepth === 0)
          barrier({ operation_id: operation.id, status: operation.status });
      }
      return operation;
    };
  }
  if (stage === 'after-local-effect') {
    const original = graph.localEffect.bind(graph);
    graph.localEffect = (...args) => {
      const result = original(...args);
      if (
        result &&
        typeof result === 'object' &&
        result.kind === 'crash.finding'
      )
        barrier({ artifact_id: result.id, sha256: result.sha256 });
      return result;
    };
  }
}
process.on('message', async ({ id, action, task_id }) => {
  try {
    let result;
    if (action === 'admit')
      result = runtime.admit(
        {
          schema_version: 'haze.task.request.v3',
          objective: 'Verify crash recovery without duplicate operations.',
        },
        'crash-test-admission',
      );
    else if (action === 'read')
      result = {
        task: runtime.store.read(task_id, localTaskIdentity),
        attempts: runtime.store.attempts(task_id, localTaskIdentity),
        artifacts: runtime.store
          .read(task_id, localTaskIdentity)
          .artifacts.map((item) =>
            runtime.store.artifact(
              item.artifact.id,
              localTaskIdentity,
              item.artifact,
            ),
          ),
        graph_nodes: runtime.store.db
          .prepare('SELECT body FROM events WHERE task_id=? ORDER BY cursor')
          .all(task_id)
          .map((row) => JSON.parse(row.body))
          .filter((event) => event.type === 'graph_node')
          .map((event) => ({ actor: event.actor, ...event.data })),
      };
    else if (action === 'resume') {
      const task = runtime.store.read(task_id, localTaskIdentity);
      result = runtime.control(
        task_id,
        {
          schema_version: 'haze.task.control.v3',
          expected_objective_revision: task.objective_revision,
          expected_run_id: task.current_run_id,
          expected_generation: task.generation,
          expected_state_revision: task.state_revision,
          action: 'resume',
        },
        'explicit-crash-replacement',
      );
    } else if (action === 'close') {
      await runtime.close();
      process.send({ id, result: true }, () => process.exit(0));
      return;
    } else throw new Error(`Unknown worker action ${action}.`);
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: { message: error.message, code: error.code } });
  }
});
process.send({ ready: true });
