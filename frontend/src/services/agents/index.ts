import type { AgentService } from './AgentService.ts';
import { HttpAgentService } from './HttpAgentService.ts';

/**
 * THE ONE PLACE that decides which agent backend answers chat questions.
 *
 * All questions use the evidence task API.
 */
const configuredBaseUrl: unknown = import.meta.env.VITE_API_BASE_URL;
// The old flag remains a fallback for existing local configuration.
const orchestrationEnabled =
  (import.meta.env.VITE_HAZE_ORCHESTRATION ??
    import.meta.env.VITE_HAZE_HYBRID) === 'true';
export const agentService: AgentService = new HttpAgentService(
  typeof configuredBaseUrl === 'string' ? configuredBaseUrl : '',
  undefined,
  undefined,
  orchestrationEnabled,
);

export {
  AgentRunError,
  AgentTaskCancelledError,
  type AgentService,
} from './AgentService.ts';
