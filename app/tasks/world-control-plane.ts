import type { SQLInputValue } from 'node:sqlite';
import {
  WORLD_BROWSE_RESPONSE_BYTES,
  worldBrowseResponseSchema,
  type WorldApiBrowseQuery,
} from '../contracts/world-api.js';
import { worldRecordSchema, type WorldRecord } from '../contracts/world.js';
import { TaskError, type TaskIdentity } from '../contracts/tasks.js';
import type { TaskStore } from './store.js';

/** Read only the current local identity and execution mode, never client scope. */
export function browseWorldRecords(
  store: TaskStore,
  identity: TaskIdentity,
  mode: WorldRecord['scope']['mode'],
  query: WorldApiBrowseQuery,
) {
  const scope = { ...identity, mode };
  const scopeParams = [identity.principal, identity.workspace, mode];
  const scopedWhere = 'principal=? AND workspace=? AND mode=?';
  const count = (table: string) =>
    (
      store.db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${scopedWhere}`)
        .get(...scopeParams) as { count: number }
    ).count;
  const kinds = store.db
    .prepare(
      `SELECT kind,COUNT(*) AS count FROM world_projection_entities
       WHERE ${scopedWhere} GROUP BY kind ORDER BY kind LIMIT 1001`,
    )
    .all(...scopeParams) as { kind: string; count: number }[];
  const base = {
    schema_version: 'haze.world.browse.v1' as const,
    scope,
    kinds: kinds.slice(0, 1000),
    kinds_truncated: kinds.length > 1000,
    counts: {
      records: count('world_projection_entities'),
      relationships: count('world_projection_relationships'),
      events: count('world_events'),
    },
    projection_cursor: store.world.projectionCursor(scope),
  };
  const clauses = [scopedWhere];
  const params: SQLInputValue[] = [...scopeParams];
  if (query.kind !== undefined) {
    clauses.push('kind=?');
    params.push(query.kind);
  }
  if (query.query !== undefined) {
    // instr keeps '%' and '_' literal, unlike a LIKE search pattern.
    clauses.push(
      "(instr(lower(record_id),lower(?))>0 OR instr(lower(json_extract(body,'$.external_id')),lower(?))>0)",
    );
    params.push(query.query, query.query);
  }
  if (query.cursor !== undefined) {
    clauses.push('last_sequence<?');
    params.push(Number(query.cursor));
  }
  params.push(query.limit + 1);
  const rows = store.db
    .prepare(
      `SELECT body,last_sequence FROM world_projection_entities
       WHERE ${clauses.join(' AND ')} ORDER BY last_sequence DESC,record_id LIMIT ?`,
    )
    .iterate(...params);
  const records: WorldRecord[] = [];
  // Leave room for the next cursor and page framing before adding record bytes.
  let bytes = Buffer.byteLength(JSON.stringify(base)) + 1024;
  let hasMore = false;
  let cursor: string | undefined;
  for (const row of rows) {
    const body = row.body as string;
    if (
      records.length === 0 &&
      bytes + Buffer.byteLength(body) + 1 > WORLD_BROWSE_RESPONSE_BYTES
    )
      throw new TaskError(
        413,
        'world_record_too_large',
        'A World Model record exceeds the browse response limit.',
      );
    if (
      records.length === query.limit ||
      bytes + Buffer.byteLength(body) + 1 > WORLD_BROWSE_RESPONSE_BYTES
    ) {
      hasMore = true;
      break;
    }
    records.push(worldRecordSchema.parse(JSON.parse(body)));
    bytes += Buffer.byteLength(body) + 1;
    cursor = String(row.last_sequence);
  }
  return worldBrowseResponseSchema.parse({
    ...base,
    records,
    has_more: hasMore,
    ...(hasMore && cursor !== undefined ? { next_cursor: cursor } : {}),
  });
}
