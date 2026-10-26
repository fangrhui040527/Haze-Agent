import { randomUUID } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import type { GraphJob, GraphLedger } from './graph-ledger.js';

/** Delivers durable jobs. It never selects dependencies, tools, or agents. */
export class GraphDispatcher {
  private readonly owner = randomUUID();
  // Delivery must not inherit a submitting graph's AsyncLocalStorage config.
  private readonly delivery = new AsyncResource('haze.graph.dispatcher');
  private readonly active = new Map<
    string,
    { job: GraphJob; controller: AbortController; promise: Promise<void> }
  >();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(
    private readonly ledger: GraphLedger,
    private readonly invoke: (
      job: GraphJob,
      signal: AbortSignal,
    ) => Promise<void | 'defer'>,
    private readonly failed: (job: GraphJob, error: unknown) => void,
  ) {
    this.timer = setInterval(() => this.kick(), 20);
    this.timer.unref();
  }
  get activeCount() {
    return new Set([...this.active.values()].map((x) => x.job.task_id)).size;
  }
  kick() {
    if (this.closed) return;
    let job: GraphJob | undefined;
    while ((job = this.ledger.claim(this.owner))) {
      const delivered = job;
      const controller = new AbortController();
      let deferred = false;
      const promise = this.delivery.runInAsyncScope(() =>
        Promise.resolve()
          .then(() => this.invoke(delivered, controller.signal))
          .then((result) => {
            deferred = result === 'defer';
          })
          .catch((error) => {
            if (!controller.signal.aborted && !this.closed)
              this.failed(delivered, error);
          })
          .finally(() => {
            if (deferred && !controller.signal.aborted)
              this.ledger.retry(delivered.id);
            else
              this.ledger.finish(
                delivered.id,
                controller.signal.aborted ? 'cancelled' : 'done',
              );
            this.active.delete(delivered.thread_id);
            if (!this.closed && !deferred) queueMicrotask(() => this.kick());
          }),
      );
      this.active.set(delivered.thread_id, {
        job: delivered,
        controller,
        promise,
      });
    }
  }
  abortTask(taskId: string, reason: string) {
    for (const item of this.active.values())
      if (item.job.task_id === taskId) item.controller.abort(reason);
  }
  reconcile(valid: (job: GraphJob) => boolean) {
    for (const item of this.active.values())
      if (!valid(item.job)) item.controller.abort('execution_fenced');
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const item of this.active.values())
      item.controller.abort('runtime_closed');
    await Promise.allSettled(
      [...this.active.values()].map((item) => item.promise),
    );
    this.delivery.emitDestroy();
  }
}
