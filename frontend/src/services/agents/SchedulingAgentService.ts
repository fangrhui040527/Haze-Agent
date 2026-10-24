import type { DemoAgentResult } from '../../../../app/demo/agent-contract.ts';
import { abortError, isAbortError } from '../../shared/lib/delay.ts';
import type {
  AgentAnswer,
  AgentEvent,
  AskRequest,
} from '../../shared/types/agents.ts';
import { AgentRunError, type AgentService } from './AgentService.ts';
import {
  isCrewSchedulingRequest,
  requestsKlangSample,
} from './schedulingIntent.ts';

const BASE = '/api/demo/crew-scheduling';
const MAX_STREAM_BYTES = 512 * 1024;
const loadSchedulingContracts = () =>
  import('../../../../app/demo/chat-contract.ts');
const loadAgentContracts = () =>
  import('../../../../app/demo/agent-contract.ts');

/** Cancels promptly even if a fetch implementation or stream ignores its signal. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(abortError());
    signal.addEventListener('abort', stop, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        if (signal.aborted) reject(abortError());
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(
          error instanceof Error
            ? error
            : new Error('The scheduling request failed.'),
        );
      },
    );
  });
}

/** Routes the fictional sample to live roles and retains general chat behavior. */
export class SchedulingAgentService implements AgentService {
  readonly label = 'Crew sample · live agents and checked schedule';
  private readonly general: AgentService;
  private readonly fetcher: typeof fetch;
  private readonly loadContracts: typeof loadSchedulingContracts;
  private readonly loadStreamContracts: typeof loadAgentContracts;

  constructor(
    general: AgentService,
    fetcher: typeof fetch = (input, init) => fetch(input, init),
    loadContracts: typeof loadSchedulingContracts = loadSchedulingContracts,
    loadStreamContracts: typeof loadAgentContracts = loadAgentContracts,
  ) {
    this.general = general;
    this.fetcher = fetcher;
    this.loadContracts = loadContracts;
    this.loadStreamContracts = loadStreamContracts;
  }

  async ask(
    request: AskRequest,
    onEvent: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentAnswer> {
    if (!isCrewSchedulingRequest(request.question)) {
      return this.general.ask(request, onEvent, signal);
    }
    const started = Date.now();
    let runId = `schedule-request-${crypto.randomUUID()}`;
    let terminalEmitted = false;
    const emit = (event: AgentEvent) => {
      onEvent(event);
      if (
        event.type === 'run_completed' ||
        event.type === 'run_failed' ||
        event.type === 'run_cancelled'
      )
        terminalEmitted = true;
    };
    const fetchResponse = async (
      path: string,
      options: RequestInit = {},
    ): Promise<Response> => {
      if (signal.aborted) throw abortError();
      try {
        return await abortable(
          this.fetcher(path, { ...options, signal, cache: 'no-store' }).then(
            (response) => {
              if (signal.aborted) {
                void response.body?.cancel().catch(() => {});
                throw abortError();
              }
              return response;
            },
          ),
          signal,
        );
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw abortError();
        throw new AgentRunError(
          'The scheduling agent service could not be reached. Keep the frontend server running and retry.',
          true,
        );
      }
    };
    const readJson = async (response: Response): Promise<unknown> => {
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new AgentRunError(
          'The scheduling service is unavailable on this host. Use npm run dev or npm run preview; static hosting needs a backend adapter.',
          false,
        );
      }
      const body: unknown = await abortable(response.json(), signal);
      if (!response.ok) {
        const detail = body as { error?: { message?: unknown } } | null;
        throw new AgentRunError(
          typeof detail?.error?.message === 'string'
            ? detail.error.message.slice(0, 2000)
            : `Scheduling request failed (${response.status}).`,
          response.status >= 500 || response.status === 409,
        );
      }
      return body;
    };

    try {
      if (signal.aborted) throw abortError();
      if (!requestsKlangSample(request.question)) {
        emit({
          type: 'run_started',
          runId,
          at: new Date().toISOString(),
          executionKind: 'local_check',
          message: 'Checking the scheduling input.',
        });
        emit({
          type: 'run_completed',
          runId,
          at: new Date().toISOString(),
          message: 'A planning bundle is needed before calculating.',
        });
        return {
          runId,
          paragraphs: [
            'Crew scheduling needs a validated planning bundle containing the workers, activities, baseline, timing constraints and evidence. Chat text alone remains a proposal and cannot produce a numerical recommendation.',
            'This frontend currently supports the fictional Klang sample. Ask “Compare the fictional Klang crew sample schedules” to try it. Your own crew data will need the controlled import and acceptance service before a real run can start.',
          ],
          citations: [],
          source: 'input_required',
          fictional: false,
          durationMs: Date.now() - started,
        };
      }

      const [{ demoChatSampleSchema }, { demoAgentStreamFrameSchema }] =
        await abortable(
          Promise.all([this.loadContracts(), this.loadStreamContracts()]),
          signal,
        ).catch(() => {
          if (signal.aborted) throw abortError();
          throw new AgentRunError(
            'The scheduling interface could not load. Keep the local frontend server running and reload this page, then retry. No numerical recommendation was displayed.',
            false,
          );
        });
      // Only the server issues the hash-bound sample reference.
      const sample = demoChatSampleSchema.parse(
        await readJson(await fetchResponse(`${BASE}/sample`)),
      );
      const response = await fetchResponse(`${BASE}/agent-runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify({
          ...sample.request,
          input: { ...sample.request.input, query: request.question },
        }),
      });
      if (!response.ok) await readJson(response);
      if (
        !response.headers
          .get('content-type')
          ?.includes('application/x-ndjson') ||
        !response.body
      ) {
        void response.body?.cancel().catch(() => {});
        throw new AgentRunError(
          'The scheduling agent stream is unavailable on this host. Keep the frontend server running and configure its model provider before retrying.',
          false,
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      let pending = '';
      let streamStarted = false;
      let completion:
        Extract<AgentEvent, { type: 'run_completed' }> | undefined;
      let result: DemoAgentResult | undefined;
      const consume = (line: string) => {
        if (signal.aborted) throw abortError();
        if (line.trim() === '') return;
        if (result)
          throw new Error('Unexpected data after the scheduling result.');
        const frame = demoAgentStreamFrameSchema.parse(JSON.parse(line));
        if (frame.type === 'event') {
          const event = frame.event;
          if (completion) throw new Error('Unexpected event after completion.');
          if (!streamStarted) {
            if (
              event.type !== 'run_started' ||
              event.executionKind !== 'agents'
            )
              throw new Error(
                'The agent stream must start with live agent execution.',
              );
            runId = event.runId;
            streamStarted = true;
          } else if (event.runId !== runId || event.type === 'run_started') {
            throw new Error('Unexpected scheduling event identity.');
          }
          if (event.type === 'run_completed') {
            // Publish completion only once its matching result and EOF validate.
            completion = event;
          } else {
            emit(event);
            if (event.type === 'run_failed')
              throw new AgentRunError(event.error, event.retryable);
            if (event.type === 'run_cancelled') throw abortError();
          }
          return;
        }
        if (!streamStarted || !completion || frame.run_id !== runId)
          throw new Error('Scheduling result arrived outside a completed run.');
        const scheduling = frame.scheduling;
        const bundle = scheduling.result.decision_ref.bundle_ref;
        if (
          scheduling.result.run_id !== runId ||
          scheduling.result.programme_id !== sample.request.programme_id ||
          scheduling.result.problem_id !== sample.request.input.problem_id ||
          bundle.sha256 !== sample.request.input.bundle_ref.sha256 ||
          bundle.id !== sample.request.input.bundle_ref.id ||
          bundle.revision !== sample.request.input.bundle_ref.revision
        )
          throw new Error('Scheduling result does not belong to this request.');
        result = frame;
      };
      try {
        while (true) {
          const chunk = await abortable(reader.read(), signal);
          if (chunk.done) {
            pending += decoder.decode();
            if (pending.trim()) consume(pending);
            break;
          }
          bytes += chunk.value.byteLength;
          if (bytes > MAX_STREAM_BYTES)
            throw new Error('Scheduling stream exceeds its size bound.');
          pending += decoder.decode(chunk.value, { stream: true });
          let newline: number;
          while ((newline = pending.indexOf('\n')) !== -1) {
            consume(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
        }
        if (signal.aborted) throw abortError();
        if (!result || !completion)
          throw new Error('The scheduling stream ended early.');
      } finally {
        // Do not wait for a broken stream's cancellation promise.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      emit(completion);
      return {
        runId,
        paragraphs: result.paragraphs,
        citations: [],
        source: 'model',
        fictional: true,
        durationMs: Date.now() - started,
        scheduling: result.scheduling,
        agentExecution: result.execution,
      };
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        if (!terminalEmitted)
          emit({
            type: 'run_cancelled',
            runId,
            at: new Date().toISOString(),
            message: 'Scheduling agent execution cancelled.',
          });
        throw abortError();
      }
      const failure =
        error instanceof AgentRunError
          ? error
          : new AgentRunError(
              'The scheduling response failed contract validation or the agent stream ended early. No numerical recommendation was displayed.',
              false,
            );
      if (!terminalEmitted)
        emit({
          type: 'run_failed',
          runId,
          at: new Date().toISOString(),
          agent: null,
          error: failure.message,
          retryable: failure.retryable,
          message: failure.message,
        });
      throw failure;
    }
  }
}
