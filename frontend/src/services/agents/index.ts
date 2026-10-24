import { mockDataService } from '../data/index.ts';
import type { AgentService } from './AgentService.ts';
import { MockAgentService } from './MockAgentService.ts';
// import { HttpAgentService } from './HttpAgentService.ts';

/**
 * THE ONE PLACE that decides which agent backend answers chat questions.
 *
 * Later: export const agentService: AgentService = new HttpAgentService(import.meta.env.VITE_API_BASE_URL);
 */
export const agentService: AgentService = new MockAgentService(() =>
  mockDataService.currentDataset(),
);

export { AgentRunError, type AgentService } from './AgentService.ts';
