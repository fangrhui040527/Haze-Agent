// One JSONL trace per run at logs/trace-RUN_ID.jsonl (redacted: no keys, no headers).
import fs from "node:fs";
import path from "node:path";
import { APP, CONFIG } from "../config.ts";
import { currentRun } from "./context.ts";

export interface TraceEvent {
  run_id: string;
  trace_id: string;
  task_id?: string;
  attempt_id?: number;
  agent_name: string;
  agent_version?: string;
  action: string;
  target_agent?: string;
  node_name?: string;
  thread_id?: string;
  checkpoint_id?: string;
  input_summary?: string;
  output_summary?: string;
  status: string;
  reasoning_backend?: string;
  source_backend?: string;
  snapshot_id?: string;
  evidence_versions?: string[];
  critic_decision?: string;
  adapter_name?: string;
  actual_service_request_id_if_available?: string;
  engine_name?: string;
  engine_version?: string;
  engine_source_revision?: string;
  engine_operation?: string;
  memory_ids?: string[];
  entity_ids?: string[];
  projection_watermark?: string;
  duration_ms?: number;
  retry_count?: number;
  failure_type?: string;
  fallback_reason?: string;
}

const SECRET = /(Bearer\s+\S+|api[_-]?key\S*|token\S*)/gi;

export function logFile(runId: string): string {
  return path.join(CONFIG.logDir, `trace-${runId}.jsonl`);
}

export function trace(e: TraceEvent): void {
  const run = currentRun();
  const line = {
    timestamp: new Date().toISOString(),
    workflow_backend: "langgraph",
    workflow_version: APP.workflowVersion,
    mode: run?.mode,
    ...e,
  };
  fs.mkdirSync(CONFIG.logDir, { recursive: true });
  fs.appendFileSync(logFile(e.run_id), JSON.stringify(line).replace(SECRET, "[redacted]") + "\n");
}
