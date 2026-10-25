import type {
  AgentId,
  AskRequest,
} from '../../../frontend/src/shared/types/agents.ts';
import type { Location } from '../../../frontend/src/shared/types/domain.ts';
import { detectIntent, findLocations, type Intent } from '../runs/answer.ts';

/**
 * The Manager (v0.14 §3–§5): the one owner of the user's objective. It keeps the
 * exact request, frames it (what kind of work, which places), creates assignments
 * for the workers and records how each one ended. Plain code, not an AI.
 *
 * It does not run jobs or enforce limits; the Runtime does (runtime/runtime.ts).
 * It cannot accept evidence, mark anything verified or override review.
 */

/**
 * The kinds of work the Manager recognises. 'general' is answered in the chat; the
 * other two open a task report (v0.14 §16) and are the only ones for now.
 */
export type TaskKind = 'general' | 'scheduling' | 'revenue_recovery';

/** The user's request, kept word for word (v0.14 §5: preserve the exact request). */
export interface Objective {
  text: string;
  revision: number;
  receivedAt: string;
  focusItemId: string | null;
}

export interface Framing {
  objective: Objective;
  kind: TaskKind;
  intent: Intent;
  places: Location[];
  /** True when the request named no place and the Manager picked one. */
  defaulted: boolean;
}

/**
 * What a worker receives with an assignment. It carries the user's original request
 * word for word, so each worker reads the same context the Manager did instead of a
 * retold version (team decision, 25 Oct 2026: no separate contract between agents).
 */
export interface Brief {
  assignmentId: string;
  parentId: string;
  agent: AgentId;
  objective: Objective;
  placeIds: string[];
  workProduct: string;
  /** Workers only read and retrieve; nothing they do is an external effect. */
  allowedEffects: 'read_only';
}

export type AssignmentState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface AssignmentView {
  id: string;
  /** The chat run or task this assignment belongs to. */
  parentId: string;
  agent: AgentId;
  workProduct: string;
  state: AssignmentState;
  startedAt: string;
  finishedAt: string | null;
  note: string | null;
}

const SCHEDULING =
  /\b(schedul\w*|rosters?|shifts?|work\s+plan|plan\s+(?:the\s+|our\s+)?(?:outdoor\s+)?work|when\s+(?:can|should)\s+(?:we|they|the\s+crew)\s+work)\b/i;
const REVENUE =
  /\b(revenue|sales|income|profits?|earnings|business|customers?|turnover)\b/i;
const RECOVERY =
  /\b(recover\w*|damage\w*|loss(?:es)?|lost|drop\w*|fell|fall\w*|impact\w*|hurt|bounce\s+back)\b/i;

export function detectTaskKind(question: string): TaskKind {
  if (REVENUE.test(question) && RECOVERY.test(question))
    return 'revenue_recovery';
  if (SCHEDULING.test(question)) return 'scheduling';
  return 'general';
}

const HISTORY_LIMIT = 200;
let counter = 0;

export class Manager {
  private readonly records: AssignmentView[] = [];

  frame(
    request: AskRequest,
    locations: readonly Location[],
    options: { focusLocationId?: string; fallbackLocationId?: string } = {},
  ): Framing {
    let places = findLocations(request.question, locations);
    if (places.length === 0 && options.focusLocationId) {
      places = locations.filter((l) => l.id === options.focusLocationId);
    }
    const defaulted = places.length === 0;
    if (defaulted && options.fallbackLocationId) {
      places = locations
        .filter((l) => l.id === options.fallbackLocationId)
        .slice(0, 1);
    }
    return {
      objective: {
        text: request.question,
        revision: 1,
        receivedAt: new Date().toISOString(),
        focusItemId: request.focusItemId,
      },
      kind: detectTaskKind(request.question),
      intent: detectIntent(request.question, places.length),
      places,
      defaulted,
    };
  }

  /** Records a new assignment and returns the brief to hand to the worker. */
  assign(
    framing: Framing,
    parentId: string,
    agent: AgentId,
    workProduct: string,
  ): Brief {
    const id = `asg_${Date.now().toString(36)}_${(++counter).toString(36)}`;
    this.records.unshift({
      id,
      parentId,
      agent,
      workProduct,
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      note: null,
    });
    this.records.length = Math.min(this.records.length, HISTORY_LIMIT);
    return {
      assignmentId: id,
      parentId,
      agent,
      objective: framing.objective,
      placeIds: framing.places.map((p) => p.id),
      workProduct,
      allowedEffects: 'read_only',
    };
  }

  finish(
    id: string,
    state: Exclude<AssignmentState, 'running'>,
    note?: string,
  ) {
    const record = this.records.find((r) => r.id === id);
    if (!record || record.state !== 'running') return;
    record.state = state;
    record.finishedAt = new Date().toISOString();
    record.note = note ?? null;
  }

  assignments(): AssignmentView[] {
    return this.records.map((r) => ({ ...r }));
  }
}
