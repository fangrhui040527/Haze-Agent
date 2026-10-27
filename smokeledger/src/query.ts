// Evidence queries. In the demo every claim-bearing query runs through Zetaris
// (QUERY_BACKEND=zetaris). Each result is hashed and stored, so anyone can re-run
// the SQL and check they get the same rows.
//
// Write SQL with the {src}. prefix for SmokeLedger tables, e.g.
//   SELECT town FROM {src}.towns
// It becomes sl_pg.towns on Zetaris and plain towns on Postgres.

import crypto from "node:crypto";
import { CONFIG } from "./config.ts";
import { db, insertMany } from "./db.ts";
import { countRemote, countSkipped, currentRun, recordFailure } from "./tracing/context.ts";

/** Backend for this call: offline_sample runs never leave the local store. */
export function activeBackend(): "zetaris" | "postgres" {
  return currentRun()?.mode === "offline_sample" ? "postgres" : CONFIG.queryBackend;
}

const READ_ONLY = /^\s*(SELECT|WITH|SHOW|DESCRIBE)\b/i;

export type Row = unknown[];

export interface Evidence {
  evidence_id: string;
  backend: string;
  sql: string;
  executed_utc: string;
  row_count: number;
  sha256: string;
  rows: Row[];
}

export function resolveSql(sql: string, backend = activeBackend()): string {
  return sql.replaceAll("{src}.", backend === "zetaris" ? `${CONFIG.zetaris.source}.` : "");
}

function assertReadOnly(sql: string): string {
  const s = sql.trim().replace(/;\s*$/, "");
  if (s.includes(";")) throw new Error("Send one SQL statement at a time.");
  if (!READ_ONLY.test(s)) throw new Error("Only SELECT / WITH / SHOW / DESCRIBE queries are allowed.");
  return s;
}

async function runZetarisOnce(sql: string, limit: number): Promise<Row[]> {
  const requestId = crypto.randomUUID();
  const res = await fetch(`${CONFIG.zetaris.url}/sql-editor/sqls/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.zetaris.apiKey}`,
      "X-Org-ID": CONFIG.zetaris.orgId,
      "X-Request-ID": requestId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ queryId: crypto.randomUUID(), sql, source: "SqlEditor", limit }),
    signal: AbortSignal.timeout(CONFIG.limits.sourceSeconds * 1000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Zetaris HTTP ${res.status}: ${text.slice(0, 300)}`);
    (err as Error & { retryable?: boolean }).retryable = res.status >= 500 || res.status === 429;
    throw err;
  }
  countRemote("zetaris.sql", requestId);
  const body = text ? JSON.parse(text) : null;
  return (body?.data as Row[] | undefined) ?? [];
}

/** Zetaris with bounded retries (at most two) for HTTP 5xx/429; a timeout is not retried. */
async function runZetaris(sql: string, limit: number): Promise<Row[]> {
  if (!CONFIG.zetaris.apiKey) throw new Error("ZETARIS_API_KEY is missing from .env");
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await runZetarisOnce(sql, limit);
    } catch (e) {
      last = e;
      // A timed-out query is usually still running in Zetaris; resending it only adds load.
      const retryable = (e as { retryable?: boolean }).retryable === true;
      if (!retryable || attempt === 2) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  recordFailure("zetaris", (last as Error).message);
  throw last;
}

async function runPostgres(sql: string, limit: number): Promise<Row[]> {
  countSkipped("zetaris.sql"); // answered from the local store, not through Zetaris
  const res = await db().query({ text: `SELECT * FROM (${sql}) q LIMIT ${limit}`, rowMode: "array" });
  return res.rows as Row[];
}

/** Normalise values (numbers, dates) so re-running the same query on the same backend gives the same hash. */
function canonical(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return Number.isInteger(v) ? v : Number(v.toPrecision(10));
  if (typeof v === "string" && /^-?\d+\.\d+(e[+-]?\d+)?$/i.test(v)) return Number(Number(v).toPrecision(10));
  if (typeof v === "bigint") return Number(v);
  return v;
}

export function hashRows(rows: Row[]): string {
  const norm = rows.map((r) => r.map(canonical));
  return crypto.createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

/** Run a read-only query on the configured backend (no evidence record). */
export async function runSql(sql: string, limit = 500): Promise<Row[]> {
  const s = assertReadOnly(resolveSql(sql));
  return activeBackend() === "zetaris" ? runZetaris(s, limit) : runPostgres(s, limit);
}

/** Run a query and store it as evidence with a hash. Returns the evidence record. */
export async function evidence(sql: string, limit = 500): Promise<Evidence> {
  const resolved = assertReadOnly(resolveSql(sql));
  const backend = activeBackend();
  const rows = (backend === "zetaris" ? await runZetaris(resolved, limit) : await runPostgres(resolved, limit)).map(
    (r) => r.map(canonical),
  );
  const sha = hashRows(rows);
  // The id covers the query and its rows: the same rows from a different query (or a
  // renamed column) are different evidence. The row hash alone still verifies a re-run.
  const id = `E-${crypto.createHash("sha256").update(resolved).update("\n").update(sha).digest("hex").slice(0, 10)}`;
  const ev: Evidence = {
    evidence_id: id,
    backend,
    sql: resolved,
    executed_utc: new Date().toISOString(),
    row_count: rows.length,
    sha256: sha,
    rows,
  };
  await insertMany(
    "evidence",
    ["evidence_id", "backend", "sql_text", "executed_utc", "row_count", "sha256", "rows_json"],
    [[id, ev.backend, ev.sql, ev.executed_utc, ev.row_count, sha, JSON.stringify(rows)]],
    "ON CONFLICT (evidence_id) DO NOTHING",
  );
  return ev;
}

/** Load stored evidence (with its rows) by id. */
export async function loadEvidence(ids: string[]): Promise<Evidence[]> {
  if (!ids.length) return [];
  const r = await db().query(
    "SELECT evidence_id, backend, sql_text, executed_utc, row_count, sha256, rows_json FROM evidence WHERE evidence_id = ANY($1)",
    [ids],
  );
  return r.rows.map((x) => ({
    evidence_id: x.evidence_id,
    backend: x.backend,
    sql: x.sql_text,
    executed_utc: new Date(x.executed_utc).toISOString(),
    row_count: Number(x.row_count),
    sha256: x.sha256,
    rows: JSON.parse(x.rows_json),
  }));
}

/** Re-run a stored evidence query and confirm the result hash still matches. */
export async function verifyEvidence(evidenceId: string): Promise<{ ok: boolean; stored: string; now: string; sql: string }> {
  const res = await db().query("SELECT sql_text, sha256 FROM evidence WHERE evidence_id = $1", [evidenceId]);
  if (!res.rows.length) throw new Error(`No evidence ${evidenceId}`);
  const { sql_text, sha256 } = res.rows[0];
  const rows = activeBackend() === "zetaris" && sql_text.includes(`${CONFIG.zetaris.source}.`) ? await runZetaris(sql_text, 100_000) : await runPostgres(sql_text, 100_000);
  const now = hashRows(rows);
  return { ok: now === sha256, stored: sha256, now, sql: sql_text };
}

/**
 * Seconds since 1970 (UTC) for a timestamp column, in the backend's dialect.
 * Use this whenever code needs to read a time back: displayed timestamp strings
 * depend on the engine's session time zone, epoch seconds do not.
 */
export function epoch(col: string, backend = activeBackend()): string {
  return backend === "zetaris" ? `unix_timestamp(${col})` : `CAST(EXTRACT(EPOCH FROM ${col}) AS BIGINT)`;
}

/** Epoch seconds (or ms, or a timestamp string) -> "2026-10-05 14:00 UTC". */
export function fmtUtc(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  const ms = Number.isFinite(n) ? (n > 1e11 ? n : n * 1000) : new Date(String(v)).getTime();
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : String(v);
}
export function toMs(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? (n > 1e11 ? n : n * 1000) : new Date(String(v)).getTime();
}

/** Guard for values interpolated into SQL (run ids, case ids, concession ids). */
export function safeId(id: string): string {
  if (!/^[A-Za-z0-9_.:\-]+$/.test(id)) throw new Error(`Unsafe id: ${id}`);
  return id;
}
export const safeText = (s: string): string => s.replaceAll("'", "''");
