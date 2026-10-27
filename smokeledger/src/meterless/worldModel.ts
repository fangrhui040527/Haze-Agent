// Build layer: Meterless World Model (official reference engine, vendored by `npm run setup`).
// It holds the shared decision state every role reads and writes:
//   - stable entities: districts, concessions, company groups, decisions
//   - evidence revisions: one fact per hashed evidence query, linked to what it is about
//   - conclusion revisions: each published answer is a new fact that supersedes the last
//   - status changes (needs_review / stale) when the heartbeat sees newer evidence
// The observation store (fires, wind, PM2.5) stays in Postgres, which Zetaris queries.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG } from "../config.ts";
import { countEngine } from "../tracing/context.ts";
import type { Evidence } from "../query.ts";

interface Fact {
  id: string;
  about: string;
  predicate: string;
  value: unknown;
  assertedAt: string;
  supersededBy?: string;
  source: { at: string; runId?: string; by?: string; kind: string };
}
interface Entity {
  id: string;
  type: string;
  name?: string;
  attrs: Record<string, unknown>;
}
interface Provenance {
  kind: string;
  by?: string;
  at: string;
  runId?: string;
}
interface WorldModelInstance {
  upsertEntity(i: { type: string; externalKey?: { system: string; id: string }; name?: string; attrs?: Record<string, unknown>; source: Provenance }): Promise<Entity>;
  relate(i: { from: string; type: string; to: string; context?: string; attrs?: Record<string, unknown>; source: Provenance }): Promise<unknown>;
  assertFact(i: { about: string; predicate: string; value: unknown; confidence?: number; source: Provenance }): Promise<Fact>;
  view(name: "facts"): { about(id: string): Fact[] };
  view(name: "graph"): { entity(id: string): Entity | undefined; neighborsOf(id: string, o?: { via?: string }): Entity[] };
  events(): readonly unknown[];
}

const ENTRY = path.resolve("vendor", "world-model", "src", "index.ts");
let instance: WorldModelInstance | null = null;
let loadError: string | null = null;

export async function worldModel(): Promise<WorldModelInstance | null> {
  if (instance || loadError) return instance;
  if (!fs.existsSync(ENTRY)) {
    loadError = "World Model not installed. Run: npm run setup";
    return null;
  }
  const mod = await import(pathToFileURL(ENTRY).href);
  fs.mkdirSync(CONFIG.worldDir, { recursive: true });
  instance = new mod.WorldModel({ namespace: "haze", storage: "local", directory: path.resolve(CONFIG.worldDir) }) as WorldModelInstance;
  return instance;
}

export function worldModelStatus(): string {
  return instance ? `World Model loaded from vendor/world-model, state in ${CONFIG.worldDir}/` : loadError ?? "World Model not loaded yet";
}

export function wmInfo() {
  return { engine_name: "meterless-world-model", engine_version: "reference", loaded: !!instance, source: "vendor/world-model" };
}

const prov = (at: string, runId?: string): Provenance => ({ kind: "agent", by: "smokeledger", at, runId });

async function must(): Promise<WorldModelInstance> {
  const w = await worldModel();
  if (!w) throw new Error(loadError ?? "World Model unavailable");
  return w;
}

export async function upsertDistrict(districtId: string, attrs: Record<string, unknown>, at: string, runId?: string): Promise<string> {
  const w = await must();
  countEngine("world_model.upsertEntity");
  return (await w.upsertEntity({ type: "district", externalKey: { system: "smokeledger", id: districtId }, name: String(attrs.town ?? districtId), attrs, source: prov(at, runId) })).id;
}

export async function upsertDecision(decisionKey: string, attrs: Record<string, unknown>, districtEntity: string, at: string, runId?: string): Promise<string> {
  const w = await must();
  countEngine("world_model.upsertEntity");
  const e = await w.upsertEntity({ type: "decision", externalKey: { system: "smokeledger", id: decisionKey }, attrs, source: prov(at, runId) });
  countEngine("world_model.relate");
  await w.relate({ from: e.id, type: "about_district", to: districtEntity, source: prov(at, runId) });
  return e.id;
}

export async function upsertConcession(
  c: { concession_id: string; name?: string | null; group_name?: string | null; map_source?: string | null; map_date?: string | null },
  at: string,
  runId?: string,
): Promise<string> {
  const w = await must();
  countEngine("world_model.upsertEntity");
  const e = await w.upsertEntity({
    type: "concession",
    externalKey: { system: "smokeledger", id: c.concession_id },
    name: c.name ?? c.concession_id,
    attrs: { map_source: c.map_source, map_date: c.map_date },
    source: prov(at, runId),
  });
  if (c.group_name) {
    countEngine("world_model.upsertEntity");
    const g = await w.upsertEntity({ type: "company_group", name: c.group_name, source: prov(at, runId) });
    countEngine("world_model.relate");
    await w.relate({ from: e.id, type: "held_by", to: g.id, source: prov(at, runId) });
  }
  return e.id;
}

/** Record an evidence revision (hashed query) against the entity it supports. */
export async function recordEvidence(ev: Evidence, aboutEntity: string, runId: string): Promise<string> {
  const w = await must();
  countEngine("world_model.assertFact");
  const f = await w.assertFact({
    about: aboutEntity,
    predicate: `evidence:${ev.evidence_id}`,
    value: { sha256: ev.sha256, row_count: ev.row_count, backend: ev.backend, sql_sha256: crypto.createHash("sha256").update(ev.sql).digest("hex") },
    confidence: 1,
    source: prov(ev.executed_utc, runId),
  });
  return f.id;
}

export interface ConclusionPayload {
  run_id: string;
  status: string; // current | needs_review | stale | superseded | insufficient_evidence
  summary: string;
  evidence_ids: string[];
  snapshot_id: string;
  change_reason?: string;
  validity: { start: string; end: string; unserved?: string[] };
}

/** Publish a new conclusion revision; World Model supersedes the previous one for the same decision. */
export async function publishConclusion(decisionEntity: string, payload: ConclusionPayload, at: string): Promise<string> {
  const w = await must();
  countEngine("world_model.assertFact");
  const f = await w.assertFact({ about: decisionEntity, predicate: "conclusion", value: payload, confidence: 1, source: prov(at, payload.run_id) });
  return f.id;
}

export async function setConclusionStatus(decisionEntity: string, status: string, reason: string, at: string, runId?: string): Promise<string> {
  const w = await must();
  countEngine("world_model.assertFact");
  const f = await w.assertFact({ about: decisionEntity, predicate: "conclusion_status", value: { status, reason }, confidence: 1, source: prov(at, runId) });
  return f.id;
}

/** All conclusion revisions for a decision, oldest first, with which one is current. */
export async function conclusionHistory(decisionEntity: string): Promise<Fact[]> {
  const w = await must();
  countEngine("world_model.view.facts");
  return w.view("facts").about(decisionEntity).filter((f) => f.predicate === "conclusion");
}

export async function eventCount(): Promise<number> {
  const w = await worldModel();
  return w ? w.events().length : 0;
}
