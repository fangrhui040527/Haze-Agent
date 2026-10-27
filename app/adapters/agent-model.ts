import { NIGHTSHIFT_CONTRACT_FAILURE } from './nightshift/runtime.js';
import {
  sampleModelAllowsNoCredential,
  sampleModelEnvironment,
  sampleModelUsesBuiltinFallback,
  prepareSampleModel,
} from './sample-model.js';

/** Server-only cache identity; never serialized into provider messages. */
export interface AgentModelCacheContext {
  version: 'haze.model-cache-bindings.v1';
  bindings: { actual: string; canonical: string }[];
  evidence: { artifact: string; semantic_sha256: string }[];
}
export interface AgentModelInput {
  role: string;
  instruction: string;
  context: unknown;
  /** Admitted by the runtime for this attempt and passed through unchanged. */
  max_output_tokens?: number;
  /** Strict JSON actions still undergo agent-owned schema validation after completion. */
  json_mode?: boolean;
  /** Runtime-owned schema; the adapter negotiates its provider representation. */
  output_schema?: unknown;
  cache_context?: AgentModelCacheContext;
}

/** Provider-returned metadata; absent fields remain unknown, not inferred. */
export interface AgentModelReceipt {
  /** Runtime-injected models and fixtures are never provider verification evidence. */
  readonly synthetic?: true;
  response_model: string | null;
  response_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** Optional for historical receipts; values come from this response only. */
  response_status?: string | null;
  http_status?: number;
  /** A recorded reply was reused; this is not a fresh provider response. */
  cache?: {
    version: 1;
    key_sha256: string;
    recorded_at: string;
    original_route: {
      provider: string;
      model: string;
      base_url?: string | null;
      capability_contract: { version: number; id: string; hash: string };
    };
    original_receipt: Omit<AgentModelReceipt, 'cache'>;
  };
}

export interface AgentModelCompletion {
  text: string;
  receipt: AgentModelReceipt;
}

/** Server-only chat-completion adapter. Credentials never enter agent context. */
export interface AgentModel {
  readonly selection: { provider: string; model: string };
  complete(input: AgentModelInput, signal: AbortSignal): Promise<string>;
  completeWithReceipt?(
    input: AgentModelInput,
    signal: AbortSignal,
  ): Promise<AgentModelCompletion>;
}

const NVIDIA_API_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
/**
 * Warm configured routes answer in seconds, but a cold endpoint can take far
 * longer, and a timeout here is charged as an unknown outcome that pauses the
 * branch. The bound absorbs one cold start and still sits inside the
 * investigation deadline.
 */
const TIMEOUT_MS = 120_000;
const MAX_REQUEST_BYTES = 131_072;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_TEXT_CHARACTERS = 12_000;

class ModelError extends Error {}
/** A provider responded, but its message was incomplete or invalid. Never accept the text as a decision. */
export class AgentModelResponseError extends ModelError {
  constructor(
    message: string,
    readonly receipt: AgentModelReceipt,
    readonly output: string | null,
  ) {
    super(message);
  }
}

/** Dispatch happened, but no provider receipt established the remote outcome. */
export class AgentModelOutcomeUnknownError extends Error {
  readonly outcome = 'unknown' as const;
}

function completionUrl(value: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error(
      'HAZE_PROVIDER_BASE_URL must be an absolute HTTP(S) API base URL.',
    );
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'HAZE_PROVIDER_BASE_URL must use HTTP(S) without credentials, query, or fragment.',
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  return url;
}

async function readCompletion(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body)
    throw new ModelError('Agent model returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        throw new ModelError('Agent model returned an invalid response body.');
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        throw new ModelError('Agent model response exceeded its size limit.');
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(
        Buffer.concat(chunks, byteLength).toString('utf8'),
      ) as unknown;
    } catch {
      throw new ModelError('Agent model returned invalid JSON.');
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Native compound schemas can stall hosted Lightning's structured decoder. */
function hasCompoundSchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCompoundSchema);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      [
        'oneOf',
        'anyOf',
        'allOf',
        '$ref',
        '$dynamicRef',
        '$recursiveRef',
      ].includes(key) || hasCompoundSchema(child),
  );
}

function assistantText(body: unknown, outputTokens: number): string {
  const choices = isRecord(body) ? body.choices : undefined;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  if (
    !isRecord(choice) ||
    choice.finish_reason !== 'stop' ||
    !isRecord(message) ||
    message.role !== 'assistant' ||
    typeof message.content !== 'string' ||
    !message.content.trim()
  ) {
    throw new ModelError(
      'Agent model did not return a complete, nonempty assistant message.' +
        (isRecord(choice) && choice.finish_reason === 'length'
          ? ` The provider reached the output token limit (${outputTokens}) for this request.`
          : ''),
    );
  }
  if (message.content.length > MAX_TEXT_CHARACTERS) {
    throw new ModelError('Agent model answer exceeded its text limit.');
  }
  return message.content.trim();
}

function receiptText(value: unknown, apiKey: string): string | null {
  if (typeof value !== 'string') return null;
  const redacted = redactCredential(value.trim(), apiKey);
  return redacted && redacted.length <= 256 ? redacted : null;
}

function redactCredential(value: string, apiKey: string): string {
  return apiKey ? value.replaceAll(apiKey, '[redacted]') : value;
}

function receiptTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function completionReceipt(
  body: unknown,
  apiKey: string,
  httpStatus: number,
): AgentModelReceipt {
  const response = isRecord(body) ? body : {};
  const usage = isRecord(response.usage) ? response.usage : {};
  const choice: unknown = Array.isArray(response.choices)
    ? response.choices[0]
    : undefined;
  return {
    response_model: receiptText(response.model, apiKey),
    response_id: receiptText(response.id, apiKey),
    input_tokens: receiptTokens(usage.prompt_tokens),
    output_tokens: receiptTokens(usage.completion_tokens),
    response_status: receiptText(
      isRecord(choice) ? choice.finish_reason : undefined,
      apiKey,
    ),
    http_status: httpStatus,
  };
}

export function resolveAgentModel(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): AgentModel {
  const sampleEnvironment = env;
  const localSampleDefault = sampleModelUsesBuiltinFallback(env);
  const timeoutMs = localSampleDefault ? 300_000 : TIMEOUT_MS;
  env = sampleModelEnvironment(env);
  const provider = env.HAZE_PROVIDER?.trim() || 'offline';
  if (provider === 'nightshift') {
    // Nightshift requires the registry's authenticated asynchronous negotiation.
    // Raw resolution must never use its general compatible routing endpoint.
    throw new Error(NIGHTSHIFT_CONTRACT_FAILURE);
  }
  if (provider === 'offline') {
    throw new Error(
      'Office agents require HAZE_PROVIDER=nvidia or openai-compatible and a server-side API key; offline mode cannot run model agents.',
    );
  }
  if (provider !== 'nvidia' && provider !== 'openai-compatible') {
    throw new Error(
      'HAZE_PROVIDER must be offline, nvidia, or openai-compatible.',
    );
  }
  const model =
    env.HAZE_MODEL?.trim() ||
    (provider === 'nvidia' ? NVIDIA_DEFAULT_MODEL : undefined);
  if (!model) throw new Error('HAZE_MODEL is required to run office agents.');
  const apiKey =
    env.HAZE_PROVIDER_API_KEY?.trim() ||
    (provider === 'nvidia' ? env.NVIDIA_API_KEY?.trim() : undefined) ||
    '';
  if (
    !apiKey &&
    !sampleModelAllowsNoCredential(env, provider, env.HAZE_PROVIDER_BASE_URL)
  ) {
    throw new Error(
      provider === 'nvidia'
        ? 'NVIDIA_API_KEY or HAZE_PROVIDER_API_KEY is required to run office agents.'
        : 'HAZE_PROVIDER_API_KEY is required to run office agents.',
    );
  }
  const url = completionUrl(
    env.HAZE_PROVIDER_BASE_URL?.trim() ||
      (provider === 'nvidia' ? NVIDIA_API_BASE_URL : undefined),
  );

  const completeWithReceipt = async (
    input: AgentModelInput,
    signal: AbortSignal,
  ): Promise<AgentModelCompletion> => {
    if (signal.aborted) {
      throw new DOMException(
        'Agent model request was cancelled.',
        'AbortError',
      );
    }
    let body: string;
    const outputTokens = input.max_output_tokens ?? 1200;
    try {
      if (
        !input.role.trim() ||
        input.role.length > 80 ||
        !input.instruction.trim() ||
        input.instruction.length > MAX_TEXT_CHARACTERS
      ) {
        throw new Error();
      }
      const nativeSchema =
        provider === 'nvidia' &&
        model === NVIDIA_DEFAULT_MODEL &&
        input.output_schema !== undefined &&
        !hasCompoundSchema(input.output_schema);
      if (input.output_schema !== undefined && !isRecord(input.output_schema))
        throw new Error();
      const context = JSON.stringify(input.context);
      if (context === undefined) throw new Error();
      const schemaInstruction =
        !nativeSchema && input.output_schema !== undefined
          ? `\nrequired_json_schema (output contract only, not an output field):\n${JSON.stringify(input.output_schema)}\nReturn only the object matching this contract. Never echo required_json_schema, schema definitions, or extra fields.`
          : '';
      if (
        !Number.isSafeInteger(outputTokens) ||
        outputTokens < 1 ||
        outputTokens > 16_384
      )
        throw new Error();
      body = JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `You are ${input.role}.\n${input.instruction}${schemaInstruction}`,
          },
          { role: 'user', content: context },
        ],
        ...(provider === 'nvidia'
          ? {
              max_tokens: outputTokens,
              // Nemotron reasoning traces precede the answer and break the
              // strict JSON action contract, so thinking stays off for every
              // model in the family rather than only the pinned default.
              ...(/nemotron/iu.test(model)
                ? { chat_template_kwargs: { enable_thinking: false } }
                : {}),
            }
          : localSampleDefault
            ? { max_tokens: outputTokens }
            : { max_completion_tokens: outputTokens }),
        stream: false,
        ...(input.json_mode
          ? {
              response_format: nativeSchema
                ? {
                    type: 'json_schema',
                    json_schema: {
                      name: 'haze_action',
                      strict: true,
                      schema: input.output_schema,
                    },
                  }
                : { type: 'json_object' },
              temperature: 0,
            }
          : {}),
      });
      if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES)
        throw new Error();
    } catch {
      throw new Error(
        'Agent model input must be bounded, JSON-serializable context with a role and instruction.',
      );
    }

    if (localSampleDefault)
      await prepareSampleModel(sampleEnvironment, fetcher, signal);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const requestSignal = AbortSignal.any([signal, deadline.signal]);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Aborted'));
      if (requestSignal.aborted) onAbort();
      else requestSignal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const request = async () => {
        requestSignal.throwIfAborted();
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body,
          signal: requestSignal,
          redirect: 'error',
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          // The status is the only way to tell a rejected request from an
          // overloaded route; it carries no credential material.
          throw new AgentModelResponseError(
            `Agent model provider request failed (HTTP ${response.status}). Check the server provider configuration.`,
            completionReceipt(null, apiKey, response.status),
            null,
          );
        }
        let responseBody: unknown;
        try {
          responseBody = await readCompletion(response, requestSignal);
        } catch (error) {
          if (error instanceof ModelError)
            throw new AgentModelResponseError(
              error.message,
              completionReceipt(null, apiKey, response.status),
              null,
            );
          throw error;
        }
        const receipt = completionReceipt(
          responseBody,
          apiKey,
          response.status,
        );
        let text: string;
        try {
          text = assistantText(responseBody, outputTokens);
        } catch (error) {
          const choices = isRecord(responseBody)
            ? responseBody.choices
            : undefined;
          const first = Array.isArray(choices)
            ? (choices[0] as unknown)
            : undefined;
          const message = isRecord(first) ? first.message : undefined;
          const content =
            isRecord(message) && typeof message.content === 'string'
              ? redactCredential(
                  message.content.slice(0, MAX_TEXT_CHARACTERS),
                  apiKey,
                )
              : null;
          throw new AgentModelResponseError(
            error instanceof Error
              ? error.message
              : 'Invalid provider response.',
            receipt,
            content,
          );
        }
        return {
          text: redactCredential(text, apiKey),
          receipt,
        };
      };
      return await Promise.race([request(), aborted]);
    } catch (error) {
      if (signal.aborted) {
        throw new DOMException(
          'Agent model request was cancelled.',
          'AbortError',
        );
      }
      if (deadline.signal.aborted) {
        // Upstream causes may contain credentials; retain only the safe outcome classification.
        throw new AgentModelOutcomeUnknownError(
          `Agent model request timed out after ${timeoutMs / 1000} seconds.`,
        );
      }
      if (error instanceof ModelError) throw error;
      // Upstream causes may contain credentials; retain only the safe outcome classification.
      throw new AgentModelOutcomeUnknownError(
        'Agent model request or response failed. Check the server provider configuration.',
      );
    } finally {
      clearTimeout(timer);
      if (onAbort) requestSignal.removeEventListener('abort', onAbort);
    }
  };
  return {
    selection: { provider, model },
    completeWithReceipt,
    async complete(input, signal) {
      return (await completeWithReceipt(input, signal)).text;
    },
  };
}
