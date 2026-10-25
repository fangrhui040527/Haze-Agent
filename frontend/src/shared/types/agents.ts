/**
 * The agent event contract.
 *
 * The chat, the status line and the pixel office render ONLY from these events.
 * The HTTP adapter publishes durable task receipts. The optional offline mock uses
 * local activity events, without depending on a retired backend contract.
 *
 * Three levels of detail are supported by the optional offline mock:
 *   A. full per-agent events          -> full animation
 *   B. only `run_state` events        -> generic "working" animation, no invented handoffs
 *   C. no backend                     -> mock plays level A, labelled as a demo simulation
 */

import type { AgentId } from './domain.ts';
import type { TaskLink } from './tasks.ts';
import type {
  TaskEvent,
  TaskRecord,
  TaskResult,
  TaskStatus,
} from '../../../../app/contracts/tasks.ts';
import type {
  ArtifactRef,
  JsonValue,
} from '../../../../app/contracts/artifacts.ts';

export type { AgentId };

/** A durable task receipt. Its message and actor come directly from the server. */
export interface TaskAgentEvent {
  type: 'task_event';
  runId: string;
  at: string;
  message: string;
  receipt: TaskEvent;
}

/** Admission/readback identity, separate from execution receipts. */
export interface AgentTaskHandle {
  id: string;
  schemaVersion: 'haze.task.v3';
  taskUrl: string;
  status: TaskStatus;
  mode?: 'live' | 'fixture' | 'replay';
  record?: TaskRecord;
}

/** UI-only events for the offline mock and its office animation. */
type ActivityAgentEvent = {
  runId: string;
  at: string;
  message: string;
} & (
  | { type: 'run_started' | 'run_completed' | 'run_cancelled' }
  | { type: 'run_state'; state: 'queued' | 'running' }
  | {
      type: 'agent_thinking' | 'agent_working' | 'agent_completed';
      agent: AgentId;
    }
  | { type: 'agent_moving'; agent: AgentId; to: 'office' | 'reception' }
  | { type: 'handoff'; from: AgentId; to: AgentId[]; payloadLabel: string }
  | {
      type: 'run_failed';
      agent: AgentId | null;
      error: string;
      retryable: boolean;
    }
);

export type AgentEvent = ActivityAgentEvent | TaskAgentEvent;

export type AgentEventType = AgentEvent['type'];

export interface Citation {
  id?: string;
  label: string;
  itemId: string | null;
  /** Exact immutable task artifact or versioned evidence selection. */
  href?: string;
  artifactId?: string;
  sha256?: string;
  selection?: unknown;
}

export interface AgentAnswer {
  runId: string;
  /** Paragraphs of the final answer. */
  paragraphs: string[];
  citations: Citation[];
  /** Where the words came from. Shown to the user; never claim "model" for a template. */
  source: 'mock_template' | 'evidence_model' | 'evidence_fixture' | 'template';
  fictional: boolean;
  durationMs: number;
  /** Optional template report opened by the separate dashboard server. */
  task?: TaskLink;
  evidence?: {
    taskUrl: string;
    result: TaskResult;
    objectiveRevision?: number;
    runId?: string;
  };
}

export interface AskRequest {
  question: string;
  /** Optional item the user asked about (from the detail page). */
  focusItemId: string | null;
  /** Reused by a retry of the same submission; scoped by the server identity. */
  idempotencyKey?: string;
  contextRefs?: ArtifactRef[];
  scope?: JsonValue;
}

export const AGENT_IDS: readonly AgentId[] = [
  'manager',
  'hazeops',
  'worldmodel',
  'hmem',
  'evidencecritic',
  'workershield',
];

export const AGENT_INFO: Record<AgentId, { name: string; role: string }> = {
  manager: {
    name: 'Manager',
    role: 'Plans the task, creates assignments, and returns the result',
  },
  hazeops: { name: 'HazeOps', role: 'Gathers data from sources' },
  worldmodel: {
    name: 'World Model',
    role: 'Disabled in the general task service',
  },
  hmem: { name: 'H-Mem', role: 'Disabled in the general task service' },
  evidencecritic: {
    name: 'EvidenceCritic',
    role: 'Checks freshness, agreement and links',
  },
  workershield: {
    name: 'WorkerShield',
    role: 'Calculates evidence coverage and ranges with reproducible methods',
  },
};
