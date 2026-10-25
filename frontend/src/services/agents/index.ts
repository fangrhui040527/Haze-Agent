import { mockDataService } from '../data/index.ts';
import type {
  AgentAnswer,
  AgentEvent,
  AskRequest,
} from '../../shared/types/agents.ts';
import type { AgentService } from './AgentService.ts';
import { HttpAgentService } from './HttpAgentService.ts';
import { MockAgentService } from './MockAgentService.ts';
import { SchedulingAgentService } from './SchedulingAgentService.ts';
import {
  isCrewSchedulingRequest,
  requestsKlangSample,
} from './schedulingIntent.ts';

const HEALTH_CACHE_MS = 30_000;

/**
 * THE ONE PLACE that decides which agent backend answers chat questions:
 * the HazeWatch server when it is reachable, otherwise the mock (labelled as a demo).
 * The fictional Klang crew sample is routed by TaskAwareAgentService (below).
 */
class AutoAgentService implements AgentService {
  private readonly http: HttpAgentService;
  private readonly mock: MockAgentService;
  private readonly baseUrl: string;
  private checked: { at: number; ok: boolean } | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.http = new HttpAgentService(this.baseUrl);
    this.mock = new MockAgentService(() => mockDataService.currentDataset());
  }

  get label(): string {
    return this.checked?.ok === false ? this.mock.label : this.http.label;
  }

  private async serverUp(): Promise<boolean> {
    if (this.checked && Date.now() - this.checked.at < HEALTH_CACHE_MS)
      return this.checked.ok;
    let ok: boolean;
    try {
      ok = (
        await fetch(`${this.baseUrl}/api/health`, {
          signal: AbortSignal.timeout(3000),
        })
      ).ok;
    } catch {
      ok = false;
    }
    this.checked = { at: Date.now(), ok };
    return ok;
  }

  async ask(
    request: AskRequest,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentAnswer> {
    return (await this.serverUp())
      ? this.http.ask(request, onEvent, signal)
      : this.mock.ask(request, onEvent, signal);
  }
}

/**
 * Real crew-scheduling requests go to the HazeWatch server, whose Manager opens a
 * scheduling task report. Only requests for the fictional Klang sample still go to
 * the sample flow in SchedulingAgentService.
 */
class TaskAwareAgentService implements AgentService {
  private readonly server: AgentService;
  private readonly withSample: AgentService;

  constructor(server: AgentService) {
    this.server = server;
    this.withSample = new SchedulingAgentService(server);
  }

  get label(): string {
    return this.server.label;
  }

  ask(
    request: AskRequest,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentAnswer> {
    const sample =
      isCrewSchedulingRequest(request.question) &&
      requestsKlangSample(request.question);
    return (sample ? this.withSample : this.server).ask(
      request,
      onEvent,
      signal,
    );
  }
}

export const agentService: AgentService = new TaskAwareAgentService(
  new AutoAgentService(
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '',
  ),
);

export { AgentRunError, type AgentService } from './AgentService.ts';
export { KLANG_CREW_EXAMPLE } from './schedulingIntent.ts';
