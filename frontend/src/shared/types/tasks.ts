/**
 * Task reports (Architecture v0.14 §16–§17). The Manager opens one when a chat
 * question needs more than a chat reply. For now only two kinds do: scheduling
 * outdoor work and recovering revenue lost to haze.
 *
 * The server streams a report block by block (GET /api/reports/:id/events), then sends
 * the finished result. The browser renders only these blocks; it never computes values.
 */

import type { AgentId } from './domain.ts';
import type { Citation } from './agents.ts';

export type TaskKind = 'scheduling' | 'revenue_recovery';

export type TaskBlock =
  | { id: string; type: 'heading'; text: string }
  | { id: string; type: 'paragraph'; text: string }
  | { id: string; type: 'quote'; text: string }
  | { id: string; type: 'bullets'; items: string[] }
  | {
      id: string;
      type: 'callout';
      tone: 'info' | 'warning';
      text: string;
    }
  | { id: string; type: 'table'; columns: string[]; rows: string[][] };

export interface TaskStep {
  id: string;
  agent: AgentId;
  label: string;
  state: 'running' | 'done' | 'failed';
}

export type TaskState =
  'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';

/** The minimum result envelope of v0.14 §16. */
export interface TaskResult {
  taskId: string;
  kind: TaskKind;
  title: string;
  objective: { text: string; revision: number };
  state: TaskState;
  blocks: TaskBlock[];
  citations: Citation[];
  /** What the answer covers: places, period and sources actually used. */
  coverage: string;
  gaps: string[];
  assumptions: string[];
  uncertainty: string[];
  openQuestions: string[];
  review: { status: 'not_reviewed'; note: string };
  asOf: string;
  nextRequirements: string[];
  provenance: {
    agents: AgentId[];
    method: 'template';
    model: null;
  };
}

export type TaskEvent =
  | { type: 'step'; step: TaskStep }
  | { type: 'block'; block: TaskBlock }
  | { type: 'result'; result: TaskResult }
  | { type: 'failed'; error: string };

/** What a chat answer carries when the Manager opened a task report. */
export interface TaskLink {
  taskId: string;
  kind: TaskKind;
  title: string;
}
