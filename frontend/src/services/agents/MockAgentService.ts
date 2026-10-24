import { composeAnswer } from '../../mock/answers.ts';
import { mockSettings } from '../../mock/settings.ts';
import { delay, isAbortError } from '../../shared/lib/delay.ts';
import type {
  AgentAnswer,
  AgentEvent,
  AgentId,
  AskRequest,
} from '../../shared/types/agents.ts';
import type { DemoDataset } from '../../shared/types/dataset.ts';
import { AgentRunError, type AgentService } from './AgentService.ts';

type EventInput = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, 'runId' | 'at'>
    : never
  : never;

/**
 * Simulates the whole agent flow (docs/03-ui-design.md §7.3) and answers from demo data.
 * Behaviour is controlled from the Demo Data page (speed, failure rate, event detail level).
 */
export class MockAgentService implements AgentService {
  readonly label = 'Mock agents (demo simulation)';
  private readonly getDataset: () => DemoDataset | null;

  constructor(getDataset: () => DemoDataset | null) {
    this.getDataset = getDataset;
  }

  async ask(
    request: AskRequest,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentAnswer> {
    const started = Date.now();
    const runId = `run-${started.toString(36)}`;
    const settings = mockSettings.get();
    const emit = (event: EventInput) =>
      onEvent({ ...event, runId, at: new Date().toISOString() });
    const wait = (ms: number) =>
      delay(ms / Math.max(0.25, settings.agentSpeed), signal);

    const failAt: AgentId | null =
      settings.agentMode === 'fail'
        ? 'evidencecritic'
        : Math.random() < settings.agentFailureRate
          ? ((['hazeops', 'evidencecritic', 'workershield'] as const)[
              Math.floor(Math.random() * 3)
            ] ?? null)
          : null;
    const maybeFail = (agent: AgentId) => {
      if (failAt !== agent) return;
      const error = 'Simulated failure: a source timed out.';
      emit({
        type: 'run_failed',
        agent,
        error,
        retryable: true,
        message: `${agentName(agent)} failed: ${error}`,
      });
      throw new AgentRunError(error, true);
    };

    try {
      const dataset = this.getDataset();
      if (!dataset) {
        emit({
          type: 'run_failed',
          agent: null,
          error: 'Demo data is not loaded yet.',
          retryable: true,
          message: 'No data loaded yet.',
        });
        throw new AgentRunError('Demo data is not loaded yet.', true);
      }
      const composed = composeAnswer(
        request.question,
        dataset,
        Date.now(),
        request.focusItemId,
      );
      const places =
        composed.locations.map((l) => l.name).join(' and ') ||
        'the top locations';

      emit({ type: 'run_started', message: 'Manager received your question.' });

      if (settings.agentMode === 'run_state') {
        // Level B: the backend only tells us the run state. No invented per-agent detail.
        await wait(500);
        emit({
          type: 'run_state',
          state: 'queued',
          message: 'Your question is queued…',
        });
        await wait(1200);
        emit({
          type: 'run_state',
          state: 'running',
          message: 'Agents are working… (step details unavailable)',
        });
        await wait(7000);
      } else {
        emit({
          type: 'agent_thinking',
          agent: 'manager',
          message: 'Manager is reading your question…',
        });
        await wait(1200);
        emit({
          type: 'agent_moving',
          agent: 'manager',
          to: 'office',
          message: 'Manager is walking to the office…',
        });
        await wait(1800);
        emit({
          type: 'handoff',
          from: 'manager',
          to: ['hazeops'],
          payloadLabel: 'task',
          message: 'Manager handed the task to HazeOps.',
        });
        await wait(500);
        emit({
          type: 'agent_working',
          agent: 'hazeops',
          message: `HazeOps is gathering data for ${places}…`,
        });
        await wait(2000);
        maybeFail('hazeops');
        emit({
          type: 'agent_completed',
          agent: 'hazeops',
          message: `HazeOps found ${composed.itemCount} relevant item(s).`,
        });
        await wait(300);
        emit({
          type: 'handoff',
          from: 'hazeops',
          to: ['worldmodel', 'hmem'],
          payloadLabel: 'records',
          message: 'HazeOps passed the records to World Model and H-Mem.',
        });
        await wait(500);
        emit({
          type: 'agent_working',
          agent: 'worldmodel',
          message: 'World Model is looking up stored records…',
        });
        emit({
          type: 'agent_working',
          agent: 'hmem',
          message:
            'World Model and H-Mem are looking up records and past episodes…',
        });
        await wait(1600);
        emit({
          type: 'agent_completed',
          agent: 'worldmodel',
          message: 'World Model returned the stored records.',
        });
        emit({
          type: 'agent_completed',
          agent: 'hmem',
          message: 'H-Mem returned similar past episodes.',
        });
        await wait(300);
        emit({
          type: 'handoff',
          from: 'worldmodel',
          to: ['evidencecritic'],
          payloadLabel: 'evidence',
          message: 'World Model passed the evidence to EvidenceCritic.',
        });
        await wait(500);
        emit({
          type: 'agent_working',
          agent: 'evidencecritic',
          message: `EvidenceCritic is checking ${composed.sourceCount} source(s)…`,
        });
        await wait(2000);
        maybeFail('evidencecritic');
        emit({
          type: 'agent_completed',
          agent: 'evidencecritic',
          message: 'EvidenceCritic finished its checks.',
        });
        await wait(300);
        emit({
          type: 'handoff',
          from: 'evidencecritic',
          to: ['workershield'],
          payloadLabel: 'checked facts',
          message: 'EvidenceCritic passed checked facts to WorkerShield.',
        });
        await wait(500);
        emit({
          type: 'agent_working',
          agent: 'workershield',
          message: 'WorkerShield is checking official guidance…',
        });
        await wait(1500);
        maybeFail('workershield');
        emit({
          type: 'agent_completed',
          agent: 'workershield',
          message: 'WorkerShield added its notes.',
        });
        await wait(300);
        emit({
          type: 'handoff',
          from: 'workershield',
          to: ['manager'],
          payloadLabel: 'answer',
          message: 'WorkerShield passed the result to the Manager.',
        });
        await wait(500);
        emit({
          type: 'agent_working',
          agent: 'manager',
          message: 'Manager is preparing the answer…',
        });
        await wait(800);
        emit({
          type: 'agent_moving',
          agent: 'manager',
          to: 'reception',
          message: 'Manager is walking back to the chat…',
        });
        await wait(1800);
      }

      emit({ type: 'run_completed', message: 'Answer ready.' });
      return {
        runId,
        paragraphs: composed.paragraphs,
        citations: composed.citations,
        source: 'mock_template',
        fictional: true,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (isAbortError(error))
        emit({ type: 'run_cancelled', message: 'Cancelled.' });
      throw error;
    }
  }
}

const NAMES: Record<AgentId, string> = {
  manager: 'Manager',
  hazeops: 'HazeOps',
  worldmodel: 'World Model',
  hmem: 'H-Mem',
  evidencecritic: 'EvidenceCritic',
  workershield: 'WorkerShield',
};
const agentName = (id: AgentId) => NAMES[id];
