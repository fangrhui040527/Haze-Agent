import { mockDataService } from '../data/index.ts';
import type { AgentService } from './AgentService.ts';
import { MockAgentService } from './MockAgentService.ts';
import { SchedulingAgentService } from './SchedulingAgentService.ts';
// import { HttpAgentService } from './HttpAgentService.ts';

/**
 * THE ONE PLACE that decides which agent backend answers chat questions.
 *
 * Later: replace the general MockAgentService below with HttpAgentService,
 * retaining scheduling dispatch until the canonical planning adapter is available.
 */
export const agentService: AgentService = new SchedulingAgentService(
  new MockAgentService(() => mockDataService.currentDataset()),
);

export { AgentRunError, type AgentService } from './AgentService.ts';
export { KLANG_CREW_EXAMPLE } from './schedulingIntent.ts';
