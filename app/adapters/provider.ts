import { z } from 'zod';
import {
  sampleModelAllowsNoCredential,
  sampleModelEnvironment,
  sampleModelUsesBuiltinFallback,
  prepareSampleModel,
} from './sample-model.js';

export interface ProbeProviderSelection {
  provider: string;
  model: string | null;
}

export type ProbeProviderResult = ProbeProviderSelection &
  (
    | {
        status: 'passed';
        kind: 'chat-completion';
        responseCharacters: number;
      }
    | {
        status: 'skipped';
        kind: 'offline';
        reason: string;
      }
    | {
        status: 'blocked' | 'failed';
        kind: 'chat-completion';
        reason: string;
      }
  );

export type ProviderProbeResult = ProbeProviderResult;

export interface ProbeProvider {
  readonly selection: ProbeProviderSelection;
  probe(): Promise<ProbeProviderResult>;
}

const completion = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.literal('assistant'),
          content: z.string().trim().min(1),
        }),
      }),
    )
    .min(1),
});

const PROBE_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 65_536;
const NVIDIA_API_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';

function offlineProvider(reason: string): ProbeProvider {
  const selection = { provider: 'offline', model: null };
  return {
    selection,
    probe: () =>
      Promise.resolve({
        ...selection,
        status: 'skipped',
        kind: 'offline',
        reason,
      }),
  };
}

function completionUrl(value: string | undefined): URL {
  let base: URL;
  try {
    base = new URL(value ?? '');
  } catch {
    throw new Error(
      'HAZE_PROVIDER_BASE_URL must be an absolute HTTP(S) API base URL.',
    );
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      'HAZE_PROVIDER_BASE_URL must use HTTP(S) without credentials, query, or fragment.',
    );
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/chat/completions`;
  return base;
}

async function readCompletion(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new Error('Selected-provider probe returned an empty response.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        throw new Error(
          'Selected-provider probe returned an invalid response body.',
        );
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(
          'Selected-provider probe response exceeded its size limit.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, byteLength);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('Selected-provider probe returned invalid JSON.');
  }
}

/** Resolve explicitly selected configuration without performing a request. */
export function resolveProbeProvider(env: NodeJS.ProcessEnv): ProbeProvider {
  const sampleEnvironment = env;
  const localSampleDefault = sampleModelUsesBuiltinFallback(env);
  env = sampleModelEnvironment(env);
  const provider = env.HAZE_PROVIDER?.trim() || 'offline';
  if (provider === 'offline') {
    return offlineProvider(
      'Offline mode selected; hosted-provider compatibility and model inference were not tested.',
    );
  }
  if (provider !== 'openai-compatible' && provider !== 'nvidia') {
    throw new Error(
      'HAZE_PROVIDER must be offline, nvidia, or openai-compatible.',
    );
  }
  const model =
    env.HAZE_MODEL?.trim() ||
    (provider === 'nvidia' ? NVIDIA_DEFAULT_MODEL : undefined);
  if (!model) {
    throw new Error('HAZE_MODEL is required for the selected-provider probe.');
  }
  const url = completionUrl(
    provider === 'nvidia' ? NVIDIA_API_BASE_URL : env.HAZE_PROVIDER_BASE_URL,
  );
  const apiKey =
    env.HAZE_PROVIDER_API_KEY?.trim() ||
    (provider === 'nvidia' ? env.NVIDIA_API_KEY?.trim() : undefined);
  const selection = { provider, model };

  return {
    selection,
    async probe() {
      if (
        !apiKey &&
        !sampleModelAllowsNoCredential(
          env,
          provider,
          env.HAZE_PROVIDER_BASE_URL,
        )
      ) {
        return {
          ...selection,
          status: 'blocked',
          kind: 'chat-completion',
          reason:
            provider === 'nvidia'
              ? 'NVIDIA_API_KEY or HAZE_PROVIDER_API_KEY is required; no NVIDIA request was made.'
              : 'HAZE_PROVIDER_API_KEY is required unless sample mode selects a loopback model; no request was made.',
        };
      }
      // Only synthetic text is sent. Neither credentials nor response text are
      // returned to the checkpoint or the compatibility report.
      const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      if (localSampleDefault)
        await prepareSampleModel(sampleEnvironment, fetch, signal);
      let response: Response;
      let body: unknown;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'user',
                content: 'Reply with the single word HAZE_OK.',
              },
            ],
            ...(provider === 'nvidia'
              ? {
                  max_tokens: 32,
                  ...(model === NVIDIA_DEFAULT_MODEL
                    ? { chat_template_kwargs: { enable_thinking: false } }
                    : {}),
                }
              : localSampleDefault
                ? { max_tokens: 32 }
                : { max_completion_tokens: 32 }),
            stream: false,
          }),
          signal,
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error();
        }
        body = await readCompletion(response);
      } catch {
        if (signal.aborted) {
          throw new Error(
            'Selected-provider probe timed out after 60 seconds.',
          );
        }
        // Fetch errors, response bodies, URLs, and upstream messages can contain
        // credentials. Keep the surfaced failure deliberately independent of them.
        throw new Error('Selected-provider probe request or response failed.');
      }
      const parsed = completion.safeParse(body);
      if (!parsed.success) {
        throw new Error(
          'Selected-provider probe did not return a nonempty assistant message.',
        );
      }
      return {
        ...selection,
        status: 'passed',
        kind: 'chat-completion',
        responseCharacters: parsed.data.choices[0]!.message.content.length,
      };
    },
  };
}
