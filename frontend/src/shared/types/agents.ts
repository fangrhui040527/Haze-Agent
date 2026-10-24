/**
 * The agent event contract.
 *
 * The chat, the status line and the pixel office render ONLY from these events.
 * The mock (src/services/agents/MockAgentService.ts) produces them today; a real backend
 * adapter must produce the same events (see README "Replacing the mock agent events").
 *
 * Three levels of detail are supported (docs/02-critique.md §5.3):
 *   A. full per-agent events          -> full animation
 *   B. only `run_state` events        -> generic "working" animation, no invented handoffs
 *   C. no backend                     -> mock plays level A, labelled as a demo simulation
 */

import type { AgentId } from './domain.ts';

export type { AgentId };

interface BaseEvent {
  runId: string;
  /** ISO timestamp. */
  at: string;
  /** Plain-language text for the status line, e.g. "EvidenceCritic is checking 4 sources…". */
  message: string;
}

export type AgentEvent =
  | (BaseEvent & { type: 'run_started' })
  /** Level B only: the backend reports the run state but not which agent is busy. */
  | (BaseEvent & { type: 'run_state'; state: 'queued' | 'running' })
  | (BaseEvent & { type: 'agent_thinking'; agent: AgentId })
  | (BaseEvent & {
      type: 'agent_moving';
      agent: AgentId;
      to: 'office' | 'reception';
    })
  | (BaseEvent & {
      type: 'handoff';
      from: AgentId;
      to: AgentId[];
      payloadLabel: string;
    })
  | (BaseEvent & { type: 'agent_working'; agent: AgentId })
  | (BaseEvent & { type: 'agent_completed'; agent: AgentId })
  | (BaseEvent & { type: 'run_completed' })
  | (BaseEvent & {
      type: 'run_failed';
      agent: AgentId | null;
      error: string;
      retryable: boolean;
    })
  | (BaseEvent & { type: 'run_cancelled' });

export type AgentEventType = AgentEvent['type'];

export interface Citation {
  label: string;
  itemId: string | null;
}

export interface AgentAnswer {
  runId: string;
  /** Paragraphs of the final answer. */
  paragraphs: string[];
  citations: Citation[];
  /** Where the words came from. Shown to the user; never claim "model" for a template. */
  source: 'mock_template' | 'model' | 'template_fallback';
  fictional: boolean;
  durationMs: number;
}

export interface AskRequest {
  question: string;
  /** Optional item the user asked about (from the detail page). */
  focusItemId: string | null;
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
    role: 'Receives your question, delegates, returns the answer',
  },
  hazeops: { name: 'HazeOps', role: 'Gathers data from sources' },
  worldmodel: { name: 'World Model', role: 'Archive of verified records' },
  hmem: { name: 'H-Mem', role: 'Recalls similar past episodes' },
  evidencecritic: {
    name: 'EvidenceCritic',
    role: 'Checks freshness, agreement and links',
  },
  workershield: {
    name: 'WorkerShield',
    role: 'Explains what it means for people outdoors, using official guidance only',
  },
};
