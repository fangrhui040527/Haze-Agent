// Shared contracts for the role agents (tasks, artifacts, claims, critic decisions).

export type Operation = "plan_outdoor_work" | "assess_haze" | "trace_sources";
export type Mode = "live" | "cached_live" | "offline_sample";

export interface Task {
  name: string;
  hours: number;
  intensity: "heavy" | "light";
}

export interface RunRequest {
  run_id: string;
  input: {
    operation: Operation;
    district_id?: string;
    town?: string;
    timezone: string;
    time_window: { start: string; end: string };
    query?: string;
    as_of?: string; // replay clock; defaults below
    tasks?: Task[]; // plan_outdoor_work
    crew_constraints?: string[]; // remembered via H-MEM, e.g. "no heavy work after 11:00"
  };
  options?: { sample_mode?: boolean };
}

/** Request after validation: everything resolved to UTC milliseconds. */
export interface Scope {
  operation: Operation;
  district_id: string;
  town: string;
  lat: number;
  lon: number;
  startMs: number;
  endMs: number;
  asOfMs: number;
  tasks: Task[];
  query: string;
  crew_constraints: string[];
  allowHindsight: boolean;
}

export type ClaimKind = "observation" | "calculation" | "forecast" | "inference" | "recommendation" | "unserved";

export interface Claim {
  id: string;
  kind: ClaimKind;
  text: string; // ends with its citations, e.g. "... [E-0123456789]."
  evidence_ids: string[];
  memory_ids?: string[];
  guidance_version?: string;
  hourMs?: number; // the hour a forecast/recommendation applies to
  basis?: "forecast" | "persistence" | "unserved";
}

export interface EvidenceRef {
  evidence_id: string;
  sha256: string;
  row_count: number;
  backend: string;
  sql: string;
  produced_by: string; // role that ran the query
}

export interface HourRow {
  tMs: number;
  pm25_hour: number | null;
  pm25_24h: number;
  api: number;
  p_close: number;
  smoke_index: number;
}

export interface Assessment {
  assessment_id: string;
  revision: number;
  as_of: string;
  projection_run_id: string;
  hindsight: boolean;
  hourly: HourRow[];
  covered_intervals: string[];
  uncovered_intervals: string[];
  claims: Claim[];
  uncertainty_basis: string;
  recheck_conditions: string[];
  drafts?: { parentNoticeBM: string; schoolNoticeBM: string };
}

export interface ScheduleSlot {
  hourMs: number;
  label: string; // "08:00-09:00"
  task: string | null;
  intensity: "heavy" | "light" | null;
  api_hourly: number | null;
  band: string | null;
  action: string;
  basis: "forecast" | "persistence" | "unserved";
}

export interface Proposal {
  proposal_id: string;
  revision: number;
  schedule: ScheduleSlot[];
  controls: string[];
  guidance_version: string | null;
  claims: Claim[];
  assumptions: string[];
  limitations: string[];
  unmet_constraints: string[];
  unserved_intervals: string[];
  narrowed: boolean;
}

export interface SourceAssessment {
  event_assessment_id: string;
  backward_run_id: string;
  claims: Claim[];
  top_concessions: { concession_id: string; name: string | null; group_name: string | null }[];
  confidence: string;
  dossier_file: string;
}

export interface Messages {
  bound_to: string; // the conclusion revision these previews were generated from
  previews: { audience: string; language: string; text: string }[];
  status: "preview";
}

export interface CriticFinding {
  code: "citation" | "hash_mismatch" | "coverage_gap" | "missing_guidance" | "hindsight_undisclosed" | "unsupported_narrative" | "no_coverage";
  message: string;
  target: "workershield" | "hazeops" | "peatfire" | "manager" | "none";
}

export interface CriticDecision {
  decision: "approve" | "revise" | "insufficient_evidence";
  findings: CriticFinding[];
  required_evidence: string[];
  checks_run: string[];
  independent_queries: string[]; // evidence ids of the critic's own re-queries
}

export interface Draft {
  summary: string;
  claims: Claim[];
  narrative: string | null;
  limitations: string[];
  assumptions: string[];
  rationale: string;
  guidance_versions: string[];
}
