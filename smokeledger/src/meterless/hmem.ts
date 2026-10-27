// Build layer: Meterless H-MEM. SmokeLedger remembers every concession's history
// across sessions and seasons (fires, notices, responses), recalls it before drafting
// a notice, and keeps an append-only trust ledger of every memory change.
//
// The engine is the official H-MEM reference, vendored by `npm run setup`
// (same pattern as Meterless' agentathon-starter).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG } from "../config.ts";
import { countEngine } from "../tracing/context.ts";

// Minimal view of the H-MEM surface we use (see vendor/hmem/src/index.ts).
interface HmemRecord {
  id: string;
  content: string;
  tags: string[];
}
interface HmemQueryResult {
  memories: { memory: HmemRecord; relevance: number }[];
  context: string;
  trace: { retrievalReason: string; strategy: string; scores: Record<string, number> };
}
interface HmemInstance {
  add(input: {
    content: string;
    type?: string;
    layer?: string;
    tags?: string[];
    confidence?: number;
    source: string;
    provenance?: { origin: string; learnedAt: number; label: string; refs?: string[] };
    missionId?: string;
    supersedes?: string;
  }): HmemRecord;
  query(q: string, opts?: { topN?: number; threshold?: number }): HmemQueryResult;
  feedback(id: string, kind: "helpful" | "not_helpful" | "wrong"): void;
  ledger: { history(id: string): unknown[]; all(): readonly unknown[]; stats(): Record<string, number> };
}

let instance: HmemInstance | null = null;
let loadError: string | null = null;

const ENTRY = path.resolve("vendor", "hmem", "src", "index.ts");

export async function hmem(): Promise<HmemInstance | null> {
  if (instance || loadError) return instance;
  if (!fs.existsSync(ENTRY)) {
    loadError = "H-MEM not installed. Run: npm run setup";
    return null;
  }
  const mod = await import(pathToFileURL(ENTRY).href);
  fs.mkdirSync(CONFIG.hmemDir, { recursive: true });
  instance = new mod.HMEM({ persistDir: path.resolve(CONFIG.hmemDir), actor: "smokeledger" }) as HmemInstance;
  return instance;
}

export function memoryStatus(): string {
  return instance ? `H-MEM loaded from vendor/hmem, state in ${CONFIG.hmemDir}/` : loadError ?? "H-MEM not loaded yet";
}

/** Store a durable fact about a concession / group / case. */
export async function remember(
  content: string,
  tags: string[],
  label: string,
  refs: string[] = [],
  supersedes?: string,
): Promise<string | null> {
  const h = await hmem();
  if (!h) return null;
  countEngine("hmem.add");
  const rec = h.add({
    supersedes,
    content,
    type: "factual",
    layer: "long_term",
    tags,
    confidence: 0.9,
    source: "smokeledger",
    provenance: { origin: "manual", learnedAt: Date.now(), label, refs },
  });
  return rec.id;
}

export interface Recalled {
  id: string;
  content: string;
  tags: string[];
  relevance: number;
}

// The reference H-MEM embedder is a deterministic hash mock, so its relevance scores
// run low; 0.2 keeps real matches. Callers also filter by tag (concession:/group:).
const RECALL_THRESHOLD = 0.2;

/** Recall what we know (e.g. "concession X fire notice history"). */
export async function recall(query: string, topN = 5): Promise<{ items: Recalled[]; context: string; reason: string }> {
  const h = await hmem();
  if (!h) return { items: [], context: "", reason: loadError ?? "" };
  countEngine("hmem.query");
  const res = h.query(query, { topN, threshold: RECALL_THRESHOLD });
  const items = res.memories.map((m) => ({ id: m.memory.id, content: m.memory.content, tags: m.memory.tags ?? [], relevance: m.relevance }));
  return { items, context: res.context, reason: res.trace?.retrievalReason ?? "" };
}

/** Append-only ledger history for one memory (H-MEM trust layer). */
export async function auditMemory(id: string): Promise<unknown[]> {
  const h = await hmem();
  if (!h) return [];
  countEngine("hmem.ledger.history");
  return h.ledger.history(id);
}

/** Engine identity for responses and traces. */
export function hmemInfo() {
  return { engine_name: "meterless-hmem", engine_version: "reference", loaded: !!instance, source: "vendor/hmem" };
}
