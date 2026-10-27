import {
  AgentModelOutcomeUnknownError,
  AgentModelResponseError,
  resolveAgentModel,
} from '../agent-model.js';
import type { AgentModel, AgentModelInput } from '../agent-model.js';
import { NIGHTSHIFT_STRICT_CONTRACT } from './runtime.js';

/** Only the negotiated endpoint may execute this admitted Nightshift route. */
export function resolveStrictNightshiftModel(
  baseUrl: string,
  model: string,
  token: string,
  fetcher: typeof fetch,
): AgentModel {
  const completeWithReceipt = async (
    input: AgentModelInput,
    signal: AbortSignal,
  ) => {
    // Per-call state avoids sharing transport observations across parallel roles.
    let contractMatched = false;
    const strictFetch: typeof fetch = async (url, request) => {
      const response = await fetcher(url, request);
      if (response.headers.get('X-Haze-Nightshift-Outcome') === 'unknown') {
        void response.body?.cancel().catch(() => undefined);
        throw new AgentModelOutcomeUnknownError(
          'Nightshift inference was dispatched without an established provider outcome.',
        );
      }
      contractMatched =
        response.headers.get('X-Haze-Nightshift-Contract') ===
        NIGHTSHIFT_STRICT_CONTRACT.id;
      return response;
    };
    // NVIDIA request encoding retains Nemotron's reasoning switch and native
    // schema support; routing and selection remain owned by this strict adapter.
    const delegate = resolveAgentModel(
      {
        HAZE_PROVIDER: 'nvidia',
        HAZE_MODEL: model,
        HAZE_PROVIDER_BASE_URL: `${baseUrl}/haze`,
        HAZE_PROVIDER_API_KEY: token,
        // The strict contract never replays a charged call, even after an overload.
        HAZE_OVERLOAD_RETRIES: '0',
      },
      strictFetch,
    );
    const completion = await delegate.completeWithReceipt!(input, signal);
    if (!contractMatched)
      throw new AgentModelResponseError(
        'Nightshift response did not identify the admitted strict-inference contract.',
        completion.receipt,
        completion.text,
      );
    if (completion.receipt.response_model !== model)
      throw new AgentModelResponseError(
        'Nightshift response did not identify the exact admitted model.',
        completion.receipt,
        completion.text,
      );
    if (
      completion.receipt.output_tokens !== null &&
      completion.receipt.output_tokens > (input.max_output_tokens ?? 1200)
    )
      throw new AgentModelResponseError(
        'Nightshift provider exceeded the admitted output-token limit.',
        completion.receipt,
        completion.text,
      );
    return completion;
  };
  return {
    selection: { provider: 'nightshift', model },
    completeWithReceipt,
    async complete(input, signal) {
      return (await completeWithReceipt(input, signal)).text;
    },
  };
}
