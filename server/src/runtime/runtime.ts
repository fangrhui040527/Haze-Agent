/**
 * The Haze runtime's job control (v0.14 §3 and §12): admits bounded jobs, enforces
 * each job's own deadline and the concurrency limit, and records what happened.
 * It makes no coordination decisions; that is the Manager's job.
 *
 * Every job brings its own deadline, sized to the work (v0.14 §12 retires the single
 * 300 s pipeline). Each pool runs at most two jobs at once. Coordinators and source
 * watchers use separate pools so a waiting coordinator cannot block its own refresh.
 * A job asked for while the same job is already queued or running is coalesced into
 * it rather than started twice.
 */

export const MAX_CONCURRENT = 2;
const HISTORY_LIMIT = 50;

export type JobState =
  'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

export interface JobView {
  id: string;
  key: string;
  label: string;
  state: JobState;
  admittedAt: string;
  deadlineAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  coalesced: number;
}

interface Job<T> extends JobView {
  work: (signal: AbortSignal) => Promise<T>;
  controller: AbortController;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

let counter = 0;

function toView(job: JobView): JobView {
  return {
    id: job.id,
    key: job.key,
    label: job.label,
    state: job.state,
    admittedAt: job.admittedAt,
    deadlineAt: job.deadlineAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    coalesced: job.coalesced,
  };
}

export class Runtime {
  private readonly queue: Job<unknown>[] = [];
  private readonly running = new Set<Job<unknown>>();
  private readonly history: JobView[] = [];

  admit<T>(
    key: string,
    label: string,
    deadlineMs: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): {
    jobId: string;
    promise: Promise<T>;
    coalesced: boolean;
  } {
    const existing = [...this.queue, ...this.running].find(
      (j) => j.key === key,
    );
    if (existing) {
      existing.coalesced += 1;
      return {
        jobId: existing.id,
        promise: existing.promise as Promise<T>,
        coalesced: true,
      };
    }
    const admittedAt = new Date();
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined); // callers may ignore background job failures
    const job: Job<T> = {
      id: `job_${admittedAt.getTime().toString(36)}_${(++counter).toString(36)}`,
      key,
      label,
      state: 'queued',
      admittedAt: admittedAt.toISOString(),
      deadlineAt: new Date(admittedAt.getTime() + deadlineMs).toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      coalesced: 0,
      work,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
    };
    this.queue.push(job as Job<unknown>);
    this.pump();
    return { jobId: job.id, promise, coalesced: false };
  }
  cancel(jobId: string): boolean {
    const job = [...this.queue, ...this.running].find((j) => j.id === jobId);
    if (!job) return false;
    job.controller.abort(new Error('cancelled'));
    return true;
  }

  jobs(): JobView[] {
    return [
      ...[...this.running].map(toView),
      ...this.queue.map(toView),
      ...this.history,
    ];
  }

  private pump(): void {
    while (this.running.size < MAX_CONCURRENT && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running.add(job);
      void this.execute(job);
    }
  }

  private async execute(job: Job<unknown>): Promise<void> {
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    const remaining = Date.parse(job.deadlineAt) - Date.now();
    const deadline =
      remaining <= 0
        ? AbortSignal.abort(
            new DOMException(
              'The job ran out of time while queued.',
              'TimeoutError',
            ),
          )
        : AbortSignal.timeout(remaining);
    const signal = AbortSignal.any([job.controller.signal, deadline]);
    try {
      signal.throwIfAborted();
      const value = await job.work(signal);
      job.state = signal.aborted
        ? deadline.aborted
          ? 'timed_out'
          : 'cancelled'
        : 'completed';
      job.resolve(value);
    } catch (error) {
      job.state = deadline.aborted
        ? 'timed_out'
        : job.controller.signal.aborted
          ? 'cancelled'
          : 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.reject(error);
    } finally {
      job.finishedAt = new Date().toISOString();
      this.running.delete(job);
      this.history.unshift(toView(job));
      this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
      this.pump();
    }
  }
}
