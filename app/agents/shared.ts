import type { z } from 'zod';
import { parseContractJson } from '../contracts/json.js';
import { TaskError } from '../contracts/tasks.js';
import type { Artifact } from '../contracts/artifacts.js';
import type { AgentAction } from '../orchestration/contracts.js';
import type {
  AgentExecutionServices,
  AssignmentOutput,
} from '../orchestration/ports.js';

/**
 * Retained evidence stays out of the model context. A specialist needs to
 * know that a method returned and what it concluded, not the rows it
 * returned: tools read pinned artifacts server-side, and evidence is
 * persisted by reference. Short scalar and string fields survive so a
 * reviewer can still read a verdict and its stated limitations.
 */
function digest(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return { items: value.length };
  const summary: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    if (item === null || typeof item === 'boolean' || typeof item === 'number')
      summary[field] = item;
    else if (typeof item === 'string')
      summary[field] = item.length <= 200 ? item : { characters: item.length };
    else if (Array.isArray(item)) {
      const text = item.filter((entry) => typeof entry === 'string');
      summary[field] =
        text.length === item.length &&
        text.reduce((total, entry) => total + entry.length, 0) <= 1_200
          ? item
          : { items: item.length };
    } else summary[field] = { fields: Object.keys(item as object).length };
  }
  return summary;
}

/**
 * How many malformed responses a specialist may correct before the run fails.
 * This is self-correction against a strict schema, not a provider retry: the
 * rejected action is never dispatched and its charged attempt is retained.
 */
const MAX_CORRECTIONS = 2;

/**
 * Validator codes are precise but not actionable. A specialist corrects a
 * malformed action far more reliably when told what to do differently than
 * when handed the parser's own vocabulary.
 */
function remedyFor(reason: string): string {
  if (reason.includes('duplicate_json_key'))
    return 'The response repeated an object key. Write every key exactly once, and send only one action.';
  if (reason.includes('unexpected_json_suffix'))
    return 'The response carried text after the JSON object. Send the object alone, with no prose and no code fences.';
  if (reason.includes('No matching discriminator') || reason.includes('type'))
    return 'The "type" field must be exactly one of tool, save, save_tool_result, question, message, wait or finish, at the top level of the object.';
  if (reason.includes('unrecognized_keys') || reason.includes('Unrecognized'))
    return 'The response carried keys the chosen variant does not define. Include only that variant’s keys.';
  if (reason.includes('Invalid option') || reason.includes('invalid_value'))
    return 'A field used a value outside its allowed set. Re-read the allowed values and choose one of them.';
  return 'Re-read the action variants and return exactly one well-formed action.';
}

/**
 * A retrieval method states where its bytes came from. Fixture output stays
 * labelled as a fixture; anything else a method retrieved is external. Absent
 * provenance is left absent rather than guessed.
 */
function originOf(result: unknown): Artifact['evidence_origin'] | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const declared = (result as { evidence_origin?: unknown }).evidence_origin;
  if (declared === 'synthetic_fixture') return 'synthetic_fixture';
  return typeof declared === 'string' ? 'external_source' : undefined;
}

/** Agent-owned bounded loop. Every boundary delegates to server-controlled execution services. */
export function boundedAgentLoop(schema: z.ZodType<AgentAction>) {
  return async (
    services: AgentExecutionServices,
  ): Promise<AssignmentOutput> => {
    const history = [...services.history];
    /** Exact tool results, kept out of the model context but persistable. */
    const retained = new Map<string, unknown>();
    let corrections = 0;
    for (let turn = 0; turn < services.maxTurns; turn++) {
      const response = await services.model({
        purpose: 'specialist',
        brief: services.brief,
        definition: services.instructions,
        // The pinned assignment input carries the admitted scope. A
        // deterministic executor reads it directly; a model-driven specialist
        // is blind to its own place and period without it.
        input: services.input,
        // References only: a tool reads the pinned content server-side.
        inputs: services.context.inputs.map((artifact) => ({
          id: artifact.id,
          version: artifact.version,
          sha256: artifact.sha256,
          kind: artifact.kind,
        })),
        // Named peer instances: a message recipient is an assignment id,
        // never an agent role, so the loop must disclose them.
        peers: services.context.peers,
        inbox: services.inbox(),
        outputs: services.context.outputs,
        history,
        tools: services.toolCards,
      });
      let action: AgentAction;
      try {
        action = schema.parse(parseContractJson(response.text));
      } catch (error) {
        // A rejected response is never accepted and never dispatched, and its
        // attempt stays charged and recorded. The agent is told exactly what
        // failed and may correct it within the turns it already holds; a
        // persistently malformed specialist still fails fast.
        const reason = (error instanceof Error ? error.message : String(error))
          .replaceAll(/\s+/gu, ' ')
          .slice(0, 400);
        // Consume the response either way: an unconsumed one is replayed, so
        // without this the next turn re-parses the same malformed text.
        services.reject(response, reason);
        if (corrections >= MAX_CORRECTIONS) throw error;
        corrections += 1;
        history.push({
          rejected_action: { reason, remedy: remedyFor(reason) },
        });
        continue;
      }
      if (!services.accept(response, action))
        throw new TaskError(
          409,
          'duplicate_action',
          'This validated action was already dispatched.',
        );
      switch (action.type) {
        case 'tool': {
          const result = await services.tool(action.tool, action.input);
          retained.set(action.id, result);
          history.push({ action, output: digest(result) });
          break;
        }
        case 'save': {
          const { id, version, sha256 } = services.save(
            action.kind,
            action.content,
          );
          history.push({ action, artifact: { id, version, sha256 } });
          break;
        }
        case 'save_tool_result': {
          if (!retained.has(action.tool_action_id))
            throw new TaskError(
              422,
              'unknown_tool_action',
              'No dispatched tool action produced that result.',
            );
          const result = retained.get(action.tool_action_id);
          // Provenance comes from the method that produced the bytes, never
          // from the model: a live external selection must not be filed as
          // derived work simply because an agent chose to persist it.
          const origin = originOf(result);
          const { id, version, sha256 } = services.save(
            action.kind,
            result,
            origin ? { evidence_origin: origin } : undefined,
          );
          history.push({ action, artifact: { id, version, sha256 } });
          break;
        }
        case 'message':
          services.message(action.recipient, action.purpose, action.text);
          history.push(action);
          break;
        case 'question':
          services.question(action.prompt);
          return {
            status: 'waiting_human',
            summary: action.prompt,
            support: 'gap',
            uncertainty: [action.prompt],
            outputs: [],
          };
        case 'wait':
          return {
            status: 'waiting_peer',
            summary: 'Waiting for an authorized peer message.',
            support: 'gap',
            uncertainty: [],
            outputs: [],
          };
        case 'finish':
          return {
            status: 'completed',
            summary: action.summary,
            support: action.support,
            uncertainty: action.uncertainty,
            outputs: action.outputs,
          };
      }
    }
    throw new TaskError(
      422,
      'local_turn_limit',
      'The specialist exhausted its bounded local turns.',
    );
  };
}
