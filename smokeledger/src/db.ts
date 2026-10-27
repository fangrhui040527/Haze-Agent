// Storage. Two interchangeable backends behind one small interface:
//  - postgres: the Docker Postgres that Zetaris registers as a datasource (live mode)
//  - pglite:   embedded Postgres in-process under STATE_DIR (offline judging, no server, no network)
//  - memory:   embedded and in-memory (tests)
// Bulk reads the physics engine needs go here directly; every number shown to users
// goes through query.ts (Zetaris in live mode).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { CONFIG } from "./config.ts";

type QueryConfig = { text: string; rowMode?: "array" };
export interface QueryResult {
  rows: any[];
  rowCount: number;
}
export interface Db {
  query(q: string | QueryConfig, params?: unknown[]): Promise<QueryResult>;
  exec(sql: string): Promise<void>;
  end(): Promise<void>;
  readonly kind: "postgres" | "pglite" | "memory";
}

class PgDb implements Db {
  readonly kind = "postgres" as const;
  private pool = new pg.Pool({ connectionString: CONFIG.pgUrl, max: 4, options: "-c timezone=UTC" });
  async query(q: string | QueryConfig, params?: unknown[]): Promise<QueryResult> {
    const r: pg.QueryResult =
      typeof q === "string" || q.rowMode !== "array"
        ? await this.pool.query(typeof q === "string" ? q : q.text, params)
        : await this.pool.query({ text: q.text, rowMode: "array", values: params } as pg.QueryArrayConfig);
    return { rows: r.rows, rowCount: r.rowCount ?? 0 };
  }
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }
  async end(): Promise<void> {
    await this.pool.end();
  }
}

class LiteDb implements Db {
  private ready: Promise<PGlite>;
  constructor(readonly kind: "pglite" | "memory", dir?: string) {
    this.ready = (async () => {
      if (dir) fs.mkdirSync(dir, { recursive: true });
      const db = new PGlite(dir);
      await db.waitReady;
      await db.exec("SET TIME ZONE 'UTC'");
      return db;
    })();
  }
  async query(q: string | QueryConfig, params: unknown[] = []): Promise<QueryResult> {
    const db = await this.ready;
    const text = typeof q === "string" ? q : q.text;
    const r = await db.query(text, params, typeof q === "object" && q.rowMode === "array" ? { rowMode: "array" } : undefined);
    return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
  }
  async exec(sql: string): Promise<void> {
    await (await this.ready).exec(sql);
  }
  async end(): Promise<void> {
    await (await this.ready).close();
  }
}

let instance: Db | null = null;

export function db(): Db {
  if (!instance) {
    if (CONFIG.dbMode === "postgres") instance = new PgDb();
    else if (CONFIG.dbMode === "memory") instance = new LiteDb("memory");
    else instance = new LiteDb("pglite", path.join(CONFIG.stateDir, "pgdata"));
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) await instance.end();
  instance = null;
}

export async function initSchema(): Promise<void> {
  const sql = fs.readFileSync(new URL("../sql/01_schema.sql", import.meta.url), "utf8");
  await db().exec(sql);
}

/** Multi-row insert in chunks. `conflict` is appended verbatim (e.g. "ON CONFLICT DO NOTHING"). */
export async function insertMany(
  table: string,
  columns: string[],
  rows: unknown[][],
  conflict = "",
  chunk = 1000,
): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = part.map((r) => {
      const ph = r.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(",")})`;
    });
    const res = await db().query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")} ${conflict}`, params);
    n += res.rowCount;
  }
  return n;
}
