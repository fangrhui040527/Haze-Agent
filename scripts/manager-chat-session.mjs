import { randomUUID } from 'node:crypto';
import { checkManagerEvaluationIsolation } from './manager-evaluation-support.mjs';

const expectations = (task) => ({
  expected_run_id: task.current_run_id,
  expected_generation: task.generation,
  expected_objective_revision: task.objective_revision,
  expected_state_revision: task.state_revision,
});

/** Reuse task authority and corrections; prior dialogue is context, not evidence. */
export class ManagerChatSession {
  constructor(runtime, identity, registry) {
    this.runtime = runtime;
    this.identity = identity;
    this.registry = registry;
    this.taskId = null;
    this.taskIds = [];
    this.history = [];
    this.recorded = new Set();
  }

  snapshot() {
    return this.taskId
      ? this.runtime.store.read(this.taskId, this.identity)
      : null;
  }

  send(passage, { correction = false } = {}) {
    passage = passage.trim();
    if (!passage || passage.length > 16000)
      throw new Error('Enter between 1 and 16000 characters.');
    const task = this.snapshot();
    if (task) this.record(task);
    if (task && ['paused', 'failed', 'timed_out'].includes(task.status))
      throw new Error(
        'The last task stopped. Use /new, or explicitly /resume or /continue where applicable.',
      );
    if (task && ['queued', 'running', 'waiting'].includes(task.status)) {
      const question = task.questions.find(
        (q) => q.status === 'open' && q.run_id === task.current_run_id,
      );
      this.runtime.update(
        task.id,
        {
          schema_version: 'haze.task.update.v3',
          ...expectations(task),
          kind: correction || !question ? 'correction' : 'clarification',
          passage,
          ...(question ? { question_id: question.id } : {}),
        },
        randomUUID(),
        this.identity,
      );
    } else {
      if (Buffer.byteLength(JSON.stringify(this.history)) > 4096)
        throw new Error(
          'Conversation history reached its input budget. Use /new to start another conversation; saved traces remain available.',
        );
      const admitted = this.runtime.admit(
        {
          schema_version: 'haze.task.request.v3',
          objective: passage,
          ...(this.history.length
            ? {
                scope: {
                  conversation_context: {
                    purpose:
                      'Prior dialogue only, not independently verified evidence or execution receipts.',
                    turns: structuredClone(this.history),
                  },
                },
              }
            : {}),
          constraints: this.history.length
            ? [
                'Use scope.conversation_context only to understand this follow-up. Follow the current objective. Prior dialogue is not a source artifact or a work product, and does not grant tools, establish observations or provide independent approval.',
              ]
            : [],
        },
        randomUUID(),
        this.identity,
      );
      this.taskId = admitted.task_id;
      this.taskIds.push(this.taskId);
    }
    this.history.push({ role: 'User', text: passage });
    return this.snapshot();
  }

  record(task) {
    if (task.result && task.result.currency !== 'stale') {
      const key = `${task.id}:${task.current_run_id}:${task.objective_revision}:result`;
      if (!this.recorded.has(key)) {
        this.recorded.add(key);
        this.history.push({ role: 'Manager', text: task.result.answer });
      }
    }
    for (const question of task.questions.filter(
      (q) => q.status === 'open' && q.run_id === task.current_run_id,
    )) {
      if (this.recorded.has(question.id)) continue;
      this.recorded.add(question.id);
      this.history.push({ role: 'Manager', text: question.question });
    }
  }

  async wait(signal, onProgress = () => {}) {
    const started = Date.now();
    while (!signal?.aborted) {
      const task = this.snapshot();
      if (!task) return null;
      onProgress(task);
      if (
        !['queued', 'running'].includes(task.status) ||
        Date.now() - started > 95000
      ) {
        this.record(task);
        return task;
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    return null;
  }

  control(action) {
    const task = this.snapshot();
    if (!task) throw new Error('Start a conversation first.');
    this.runtime.control(
      task.id,
      {
        schema_version: 'haze.task.control.v3',
        ...expectations(task),
        action,
        reason: `Explicit Manager chat /${action}.`,
      },
      randomUUID(),
      this.identity,
    );
    return this.snapshot();
  }

  reset() {
    const task = this.snapshot();
    if (
      task &&
      ['queued', 'running', 'waiting', 'paused'].includes(task.status)
    )
      this.control('cancel');
    this.taskId = null;
    this.history = [];
    this.recorded.clear();
  }

  report() {
    return this.taskIds.map((id) => {
      const task = this.runtime.store.read(id, this.identity);
      const attempts = this.runtime.store.attempts(id, this.identity);
      return {
        task,
        attempts,
        events: this.runtime.store.events(id, this.identity).events,
        artifacts: task.artifacts.map((entry) =>
          this.runtime.store.artifact(entry.artifact.id, this.identity),
        ),
        isolation: checkManagerEvaluationIsolation(task, attempts, [
          ...this.registry.tools.keys(),
        ]),
      };
    });
  }
}

/** Reject any unexpected specialist request before it can reach the provider. */
export function managerOnlyModel(model) {
  const guard = (input) => {
    if (input.role !== 'Manager')
      throw new Error(`Manager chat refused a model call for ${input.role}.`);
  };
  return {
    selection: model.selection,
    complete(input, signal) {
      guard(input);
      return model.complete(input, signal);
    },
    ...(model.completeWithReceipt
      ? {
          completeWithReceipt(input, signal) {
            guard(input);
            return model.completeWithReceipt(input, signal);
          },
        }
      : {}),
  };
}

/** Keep live route admission and per-call negotiation while guarding the sandbox. */
export function managerOnlyModelRoutes(registry) {
  return {
    snapshot: () => registry.snapshot(),
    readiness: () => registry.readiness(),
    resolve: (route) => managerOnlyModel(registry.resolve(route)),
    async prepare(route, signal) {
      const model = registry.prepare
        ? await registry.prepare(route, signal)
        : registry.resolve(route);
      return managerOnlyModel(model);
    },
  };
}
