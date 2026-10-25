// The LangGraph workflow (TypeScript StateGraph, no hosted LangGraph service).
//
//   START -> admit -> manager --(next)--> hazeops | peatfire | workershield --> manager
//                       \--> synthesize -> critic --approve--> gate -> communityalert -> END
//                                             |--revise-----> revise -> manager   (max 2 rounds)
//                                             \--insufficient--> partial -> END
//
// LangGraph owns transitions and checkpoints (SQLite under STATE_DIR, thread = run_id).
// The harness owns permissions, the run deadline, idempotent writes and publication.

import fs from "node:fs";
import path from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { CONFIG } from "../config.ts";
import { activeBackend } from "../query.ts";
import { currentRun, remainingMs } from "../tracing/context.ts";
import { trace } from "../tracing/trace.ts";
import type { Recalled } from "../meterless/hmem.ts";
import type { Assessment, CriticDecision, Draft, EvidenceRef, Messages, Mode, Proposal, Scope, SourceAssessment } from "./types.ts";
import { DeadlineError } from "../agents/common.ts";
import { admit, MANAGER_VERSION, planRevision, publish, synthesize, type Outcome, type Snapshot } from "../agents/manager.ts";
import { assess, HAZEOPS_VERSION } from "../agents/hazeops.ts";
import { propose, WORKERSHIELD_VERSION } from "../agents/workershield.ts";
import { investigate, PEATFIRE_VERSION } from "../agents/peatfire.ts";
import { review, CRITIC_VERSION } from "../agents/critic.ts";
import { COMMUNITYALERT_VERSION, previews } from "../agents/communityalert.ts";

const mergeEvidence = (a: EvidenceRef[], b: EvidenceRef[]) => {
  const seen = new Set(a.map((e) => e.evidence_id));
  return [...a, ...b.filter((e) => !seen.has(e.evidence_id) && seen.add(e.evidence_id))];
};

export const State = Annotation.Root({
  run_id: Annotation<string>,
  mode: Annotation<Mode>,
  scope: Annotation<Scope>,
  decision_key: Annotation<string>,
  decision_entity: Annotation<string>,
  snapshot: Annotation<Snapshot>,
  memories: Annotation<Recalled[]>,
  queue: Annotation<string[]>,
  next: Annotation<string>,
  assessment: Annotation<Assessment | null>,
  sources: Annotation<SourceAssessment | null>,
  proposal: Annotation<Proposal | null>,
  narrow: Annotation<boolean>,
  disable_narrative: Annotation<boolean>,
  evidence: Annotation<EvidenceRef[]>({ reducer: mergeEvidence, default: () => [] }),
  draft: Annotation<Draft | null>,
  verdict: Annotation<CriticDecision | null>,
  critic_history: Annotation<CriticDecision[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  rounds: Annotation<number>,
  agents: Annotation<{ role: string; version: string; attempts: number }[]>({
    reducer: (a, b) => {
      const out = a.map((x) => ({ ...x }));
      for (const r of b) {
        const hit = out.find((x) => x.role === r.role);
        if (hit) hit.attempts += r.attempts;
        else out.push({ ...r });
      }
      return out;
    },
    default: () => [],
  }),
  outcome: Annotation<Outcome | null>,
  messages: Annotation<Messages | null>,
});
export type GraphState = typeof State.State;

type NodeFn = (s: GraphState) => Promise<Partial<GraphState>>;

/** Wraps a node: deadline check, timing, and one JSONL trace event per execution. */
function node(name: string, agent: string, version: string, fn: NodeFn): NodeFn {
  return async (s) => {
    if (remainingMs() <= 0) throw new DeadlineError(`Run deadline passed before ${name}`);
    const t0 = Date.now();
    const before = { ...(currentRun()?.engine_operations_executed ?? {}) };
    try {
      const out = await fn(s);
      const after = currentRun()?.engine_operations_executed ?? {};
      const engineOps = Object.keys(after).filter((k) => (after[k] ?? 0) !== (before[k] ?? 0));
      trace({
        run_id: s.run_id,
        trace_id: s.run_id,
        task_id: `${s.run_id}:${name}`,
        attempt_id: (s.agents.find((a) => a.role === agent)?.attempts ?? 0) + 1,
        agent_name: agent,
        agent_version: version,
        action: name,
        node_name: name,
        thread_id: s.run_id,
        status: "ok",
        snapshot_id: (out.snapshot ?? s.snapshot)?.snapshot_id,
        evidence_versions: (out.evidence ?? []).map((e) => `${e.evidence_id}:${e.sha256.slice(0, 12)}`),
        critic_decision: out.verdict?.decision,
        engine_operation: engineOps.join(",") || undefined,
        memory_ids: (out.memories ?? []).map((m) => m.id),
        output_summary: summarizeOut(out),
        reasoning_backend: currentRun()?.mode === "offline_sample" ? "deterministic" : undefined,
        source_backend: activeBackend() === "zetaris" ? "zetaris" : CONFIG.sampleMode ? "sample_fixture" : "local_store",
        duration_ms: Date.now() - t0,
      });
      return { ...out, agents: [{ role: agent, version, attempts: 1 }] };
    } catch (e) {
      trace({
        run_id: s.run_id,
        trace_id: s.run_id,
        agent_name: agent,
        agent_version: version,
        action: name,
        node_name: name,
        status: "error",
        failure_type: e instanceof DeadlineError ? "deadline" : (e as Error).name,
        output_summary: (e as Error).message.slice(0, 300),
        duration_ms: Date.now() - t0,
      });
      throw e;
    }
  };
}

function summarizeOut(o: Partial<GraphState>): string {
  if (o.verdict) return `${o.verdict.decision}: ${o.verdict.findings.map((f) => f.code).join(", ") || "no findings"}`;
  if (o.proposal) return `proposal ${o.proposal.proposal_id} r${o.proposal.revision}, ${o.proposal.unserved_intervals.length ? `unserved ${o.proposal.unserved_intervals.join("; ")}` : "full window"}`;
  if (o.assessment) return `assessment ${o.assessment.assessment_id}: covered ${o.assessment.covered_intervals.join("; ") || "none"}; uncovered ${o.assessment.uncovered_intervals.join("; ") || "none"}`;
  if (o.sources) return `sources ${o.sources.event_assessment_id}, confidence ${o.sources.confidence}`;
  if (o.outcome) return `${o.outcome.status} / ${o.outcome.conclusion_status} / ${o.outcome.conclusion_revision_id}`;
  if (o.next) return `next: ${o.next}`;
  return "";
}

const G = new StateGraph(State)
  .addNode(
    "admit",
    node("admit", "manager", MANAGER_VERSION, async (s) => {
      const r = await admit(s.scope, s.run_id, s.decision_key);
      return { snapshot: r.snapshot, memories: r.memories, queue: r.queue, decision_entity: r.decisionEntity, rounds: 0, narrow: false, disable_narrative: false };
    }),
  )
  .addNode(
    "manager",
    node("route", "manager", MANAGER_VERSION, async (s) => ({ next: s.queue[0] ?? "synthesize", queue: s.queue.slice(1) })),
  )
  .addNode(
    "hazeops",
    node("assess", "hazeops", HAZEOPS_VERSION, async (s) => {
      const r = await assess(s.scope, s.run_id, (s.assessment?.revision ?? 0) + 1);
      return { assessment: r.assessment, evidence: r.evidence };
    }),
  )
  .addNode(
    "peatfire",
    node("investigate", "peatfire_sentinel", PEATFIRE_VERSION, async (s) => {
      const r = await investigate(s.scope, s.run_id);
      return { sources: r.assessment, evidence: r.evidence };
    }),
  )
  .addNode(
    "workershield",
    node("propose", "workershield", WORKERSHIELD_VERSION, async (s) => {
      if (!s.assessment) throw new Error("WorkerShield needs a HazeOps assessment first");
      const r = await propose(s.scope, s.assessment, s.run_id, (s.proposal?.revision ?? 0) + 1, s.narrow, s.memories);
      return { proposal: r.proposal, evidence: r.evidence };
    }),
  )
  .addNode(
    "synthesize",
    node("synthesize", "manager", MANAGER_VERSION, async (s) => ({
      draft: await synthesize(s.scope, s.assessment, s.proposal, s.sources, s.memories, !s.disable_narrative),
    })),
  )
  .addNode(
    "critic",
    node("review", "evidence_critic", CRITIC_VERSION, async (s) => {
      const r = await review(s.scope, s.draft!, s.evidence, s.memories, s.rounds, s.assessment ?? undefined, s.proposal ?? undefined);
      return { verdict: r.decision, critic_history: [r.decision], evidence: r.evidence };
    }),
  )
  .addNode(
    "revise",
    node("revise", "manager", MANAGER_VERSION, async (s) => {
      const r = planRevision(s.verdict!, s.scope.operation);
      return { queue: r.queue, narrow: s.narrow || r.narrow, disable_narrative: s.disable_narrative || r.disableNarrative, rounds: s.rounds + 1 };
    }),
  )
  .addNode(
    "gate",
    node("publish", "manager", MANAGER_VERSION, async (s) => ({
      outcome: await publish(s.scope, s.run_id, s.decision_key, s.decision_entity, s.snapshot, s.draft!, s.evidence, s.proposal, true),
    })),
  )
  .addNode(
    "partial",
    node("publish_insufficient", "manager", MANAGER_VERSION, async (s) => ({
      outcome: await publish(s.scope, s.run_id, s.decision_key, s.decision_entity, s.snapshot, s.draft!, s.evidence, s.proposal, false),
    })),
  )
  .addNode(
    "communityalert",
    node("preview", "communityalert", COMMUNITYALERT_VERSION, async (s) => ({
      messages: previews(s.scope, s.outcome?.conclusion_revision_id ?? "", s.assessment ?? undefined, s.proposal ?? undefined),
    })),
  )
  .addEdge(START, "admit")
  .addEdge("admit", "manager")
  .addConditionalEdges("manager", (s) => s.next, ["hazeops", "peatfire", "workershield", "synthesize"])
  .addEdge("hazeops", "manager")
  .addEdge("peatfire", "manager")
  .addEdge("workershield", "manager")
  .addEdge("synthesize", "critic")
  .addConditionalEdges(
    "critic",
    (s) => (s.verdict!.decision === "approve" ? "gate" : s.verdict!.decision === "revise" ? "revise" : "partial"),
    ["gate", "revise", "partial"],
  )
  .addEdge("revise", "manager")
  .addEdge("gate", "communityalert")
  .addEdge("communityalert", END)
  .addEdge("partial", END);

let compiled: ReturnType<typeof G.compile> | null = null;

export function graph() {
  if (!compiled) {
    fs.mkdirSync(CONFIG.stateDir, { recursive: true });
    const saver = SqliteSaver.fromConnString(path.join(CONFIG.stateDir, "checkpoints.sqlite"));
    compiled = G.compile({ checkpointer: saver });
  }
  return compiled;
}
