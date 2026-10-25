import type { AgentService } from './AgentService.ts';
import { HttpAgentService } from './HttpAgentService.ts';
const configuredBaseUrl: unknown = import.meta.env.VITE_API_BASE_URL;
/** Every submission uses the same general protocol. */
export const agentService: AgentService = new HttpAgentService(
  typeof configuredBaseUrl === 'string' ? configuredBaseUrl : '',
);
export {
  AgentRunError,
  AgentTaskCancelledError,
  type AgentService,
} from './AgentService.ts';
