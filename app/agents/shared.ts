import type { z } from 'zod';
import { parseContractJson } from '../contracts/json.js';
import { TaskError } from '../contracts/tasks.js';
import type { AgentAction } from '../orchestration/contracts.js';
import type {
  AgentExecutionServices,
  AssignmentOutput,
} from '../orchestration/ports.js';

/** Agent-owned bounded loop. Every boundary delegates to server-controlled execution services. */
export function boundedAgentLoop(schema: z.ZodType<AgentAction>) {
  return async (
    services: AgentExecutionServices,
  ): Promise<AssignmentOutput> => {
    const history = [...services.history];
    for (let turn = 0; turn < services.maxTurns; turn++) {
      const response = await services.model({
        purpose: 'specialist',
        brief: services.brief,
        definition: services.instructions,
        inputs: services.context.inputs,
        inbox: services.inbox(),
        outputs: services.context.outputs,
        history,
        tools: services.toolCards,
      });
      const action = schema.parse(parseContractJson(response.text));
      if (!services.accept(response, action))
        throw new TaskError(
          409,
          'duplicate_action',
          'This validated action was already dispatched.',
        );
      switch (action.type) {
        case 'tool':
          history.push({
            action,
            output: await services.tool(action.tool, action.input),
          });
          break;
        case 'save': {
          const { id, version, sha256 } = services.save(
            action.kind,
            action.content,
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
