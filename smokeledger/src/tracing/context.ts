// Per-run context carried through async calls (AsyncLocalStorage): counts what
// actually executed, so responses and traces never claim a skipped call ran.
import { AsyncLocalStorage } from "node:async_hooks";

export interface RunCounters {
  run_id: string;
  mode: "live" | "cached_live" | "offline_sample";
  engine_operations_executed: Record<string, number>; // e.g. "hmem.query": 2, "world_model.assertFact": 3
  remote_calls_executed: Record<string, number>; // "zetaris.sql": 7, "nightshift.chat": 2
  remote_calls_skipped: Record<string, number>;
  remote_call_ids: string[]; // request ids we sent (X-Request-ID), as receipts
  failures: { dependency: string; message: string }[];
  deadlineMs: number;
}

const als = new AsyncLocalStorage<RunCounters>();

export function withRun<T>(ctx: RunCounters, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}
export const currentRun = (): RunCounters | undefined => als.getStore();

const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);
export function countEngine(op: string): void {
  const c = als.getStore();
  if (c) bump(c.engine_operations_executed, op);
}
export function countRemote(op: string, requestId?: string): void {
  const c = als.getStore();
  if (!c) return;
  bump(c.remote_calls_executed, op);
  if (requestId) c.remote_call_ids.push(`${op}:${requestId}`);
}
export function countSkipped(op: string): void {
  const c = als.getStore();
  if (c) bump(c.remote_calls_skipped, op);
}
export function recordFailure(dependency: string, message: string): void {
  als.getStore()?.failures.push({ dependency, message: message.slice(0, 300) });
}
/** Hosted inference is off in offline_sample mode (or with no token): callers must take the deterministic path. */
export function hostedInferenceAllowed(hasToken: boolean): boolean {
  const c = als.getStore();
  if (c && c.mode === "offline_sample") return false;
  return hasToken;
}
export function remainingMs(): number {
  const c = als.getStore();
  return c ? c.deadlineMs - Date.now() : Infinity;
}
