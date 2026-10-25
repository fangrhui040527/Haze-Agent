import type {
  AgentModel,
  AgentModelCompletion,
  AgentModelInput,
  AgentModelReceipt,
} from '../adapters/agent-model.js';
import { resolveAgentModel } from '../adapters/agent-model.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../contracts/json.js';
import {
  PM25_SOURCE_ID,
  resolveEvidenceSource,
  type EvidenceCapture,
  type EvidenceScope,
  type EvidenceSource,
} from '../tasks/evidence.js';

export type IntegrationMode = 'live' | 'fixture';

/** Server-owned assignment metadata. These fields never grant permissions. */
export interface ExecutionContext {
  taskId: string;
  assignmentId: string;
  objectiveRevision: number;
  generation: number;
  identity: { principal: string; workspace: string };
  deadline: string;
  signal: AbortSignal;
  modelLimits?: { maxInputBytes: number; maxOutputTokens: number };
}

export interface IntegrationRef {
  id: string;
  /** Immutable snapshot/record version, not an entity schema version. */
  version: string;
  /** SHA-256 of Haze canonical JSON for the exact returned content. */
  sha256: string;
}

export type EnrichmentResult =
  | {
      status: 'available';
      ref: IntegrationRef;
      content: unknown;
      limitations: string[];
    }
  | { status: 'unavailable'; reason: string };

export interface ReviewedLessonInput {
  content: string;
  evidenceRefs: IntegrationRef[];
  reviewRef: IntegrationRef;
}

export type ReviewedLessonResult =
  | { status: 'captured'; ref: IntegrationRef }
  | { status: 'disabled'; reason: string };

export interface NightShiftPort {
  readonly id: string;
  readonly mode: IntegrationMode;
  /** Configured route; distinct from the provider-returned model receipt. */
  readonly selection?: { provider: string; model: string } | undefined;
  execute(
    input: AgentModelInput,
    context: ExecutionContext,
  ): Promise<AgentModelCompletion>;
}

export interface ZetarisPort {
  readonly id: string;
  readonly mode: IntegrationMode;
  retrieve(
    scope: EvidenceScope,
    context: ExecutionContext,
  ): Promise<EvidenceCapture>;
}

export interface HMemPort {
  readonly id: string;
  recall(query: string, context: ExecutionContext): Promise<EnrichmentResult>;
  captureReviewedLesson(
    lesson: ReviewedLessonInput,
    context: ExecutionContext,
  ): Promise<ReviewedLessonResult>;
}

export interface WorldModelPort {
  readonly id: string;
  readSnapshot(
    query: string,
    context: ExecutionContext,
  ): Promise<EnrichmentResult>;
}

export interface IntegrationPorts {
  nightshift: NightShiftPort;
  zetaris: ZetarisPort;
  hmem: HMemPort;
  world: WorldModelPort;
}

export class IntegrationPortError extends Error {
  constructor(
    readonly code:
      | 'invalid_context'
      | 'invalid_response'
      | 'unavailable'
      | 'cancelled'
      | 'deadline_exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'IntegrationPortError';
  }
}

const unknownReceipt: AgentModelReceipt = {
  response_model: null,
  response_id: null,
  input_tokens: null,
  output_tokens: null,
};

export const MAX_ENRICHMENT_CONTENT_BYTES = 65_536;
const LEGACY_MODEL_OUTPUT_CAP = 700;

function boundedText(value: unknown, maximum = 2000): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

function invalidResponse(message: string): never {
  throw new IntegrationPortError('invalid_response', message);
}

/** Enforce deadline/cancellation even when a component ignores its signal. */
export async function runWithExecutionContext<T>(
  context: ExecutionContext,
  operation: (boundedContext: ExecutionContext) => Promise<T>,
): Promise<T> {
  const until = Date.parse(context.deadline);
  if (
    !boundedText(context.taskId, 200) ||
    !boundedText(context.assignmentId, 200) ||
    !Number.isSafeInteger(context.objectiveRevision) ||
    context.objectiveRevision < 1 ||
    !Number.isSafeInteger(context.generation) ||
    context.generation < 1 ||
    !boundedText(context.identity.principal, 200) ||
    !boundedText(context.identity.workspace, 200) ||
    !Number.isFinite(until) ||
    (context.modelLimits !== undefined &&
      (!Number.isSafeInteger(context.modelLimits.maxInputBytes) ||
        context.modelLimits.maxInputBytes < 1 ||
        !Number.isSafeInteger(context.modelLimits.maxOutputTokens) ||
        context.modelLimits.maxOutputTokens < 1))
  ) {
    throw new IntegrationPortError(
      'invalid_context',
      'Component execution requires bounded server-owned assignment context.',
    );
  }
  const cancelled = () =>
    new IntegrationPortError('cancelled', 'Component execution was cancelled.');
  const expired = () =>
    new IntegrationPortError(
      'deadline_exceeded',
      'Component execution exceeded the assignment deadline.',
    );
  if (context.signal.aborted) throw cancelled();
  if (Date.now() >= until) throw expired();
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    timer = setTimeout(
      () => {
        if (Date.now() < until) schedule();
        else controller.abort();
      },
      Math.min(until - Date.now(), 2_147_483_647),
    );
  };
  schedule();
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(context.signal.aborted ? cancelled() : expired());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([
      operation({ ...context, signal }),
      stopped,
    ]);
    if (context.signal.aborted) throw cancelled();
    if (Date.now() >= until) throw expired();
    return result;
  } finally {
    clearTimeout(timer!);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Preserve actual metadata; the configured route is never inferred as a receipt. */
export function validateModelCompletion(
  completion: AgentModelCompletion,
  limits?: ExecutionContext['modelLimits'],
): AgentModelCompletion {
  if (!completion || !boundedText(completion.text, 12_000)) {
    return invalidResponse('Model output must be bounded nonempty text.');
  }
  const receipt = completion.receipt;
  if (
    !receipt ||
    ![receipt.response_model, receipt.response_id].every(
      (value) => value === null || boundedText(value, 256),
    ) ||
    ![receipt.input_tokens, receipt.output_tokens].every(
      (value) => value === null || (Number.isSafeInteger(value) && value >= 0),
    )
  ) {
    return invalidResponse('Model receipt contains invalid response metadata.');
  }
  if (
    limits &&
    receipt.output_tokens !== null &&
    receipt.output_tokens > limits.maxOutputTokens
  ) {
    return invalidResponse(
      'Reported model output exceeded the assignment token limit.',
    );
  }
  return {
    text: completion.text,
    receipt: {
      response_model: receipt.response_model,
      response_id: receipt.response_id,
      input_tokens: receipt.input_tokens,
      output_tokens: receipt.output_tokens,
    },
  };
}

/** Count the JSON model input, before provider-specific transport framing. */
export function validateModelInput(
  input: AgentModelInput,
  limits: ExecutionContext['modelLimits'],
): void {
  if (!limits) return;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  } catch {
    return invalidResponse('Model input must be bounded JSON.');
  }
  if (bytes > limits.maxInputBytes) {
    return invalidResponse('Model input exceeded the assignment byte limit.');
  }
}

export function validateEnrichmentResult(
  result: EnrichmentResult,
): EnrichmentResult {
  if (!result || typeof result !== 'object') {
    return invalidResponse(
      'Enrichment must return an explicit availability result.',
    );
  }
  if (result.status === 'unavailable') {
    if (!boundedText(result.reason)) {
      return invalidResponse('Unavailable enrichment must include a reason.');
    }
    return { status: 'unavailable', reason: result.reason };
  }
  if (
    result.status !== 'available' ||
    !result.ref ||
    !boundedText(result.ref.id, 200) ||
    !boundedText(result.ref.version, 200) ||
    !/^[a-f0-9]{64}$/u.test(result.ref.sha256) ||
    !Array.isArray(result.limitations) ||
    result.limitations.length > 32 ||
    !result.limitations.every((value) => boundedText(value))
  ) {
    return invalidResponse(
      'Enrichment requires an immutable versioned reference.',
    );
  }
  let actual: string;
  try {
    const serialized = canonicalJson(result.content);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ENRICHMENT_CONTENT_BYTES) {
      return invalidResponse(
        'Enrichment content exceeded the 65536-byte limit.',
      );
    }
    actual = createHash('sha256').update(serialized, 'utf8').digest('hex');
  } catch (error) {
    if (error instanceof IntegrationPortError) throw error;
    return invalidResponse(
      'Enrichment content must be bounded canonical JSON.',
    );
  }
  if (actual !== result.ref.sha256) {
    return invalidResponse(
      'Enrichment content does not match its snapshot hash.',
    );
  }
  return {
    status: 'available',
    ref: {
      id: result.ref.id,
      version: result.ref.version,
      sha256: result.ref.sha256,
    },
    content: result.content,
    limitations: [...result.limitations],
  };
}

export function createNightShiftPort(
  model: AgentModel,
  id = 'configured-agent-model',
): NightShiftPort {
  return {
    id,
    mode: 'live',
    selection: { ...model.selection },
    execute: (input, context) =>
      runWithExecutionContext(context, async ({ signal, modelLimits }) => {
        validateModelInput(input, modelLimits);
        if (
          modelLimits &&
          modelLimits.maxOutputTokens < LEGACY_MODEL_OUTPUT_CAP
        ) {
          throw new IntegrationPortError(
            'invalid_context',
            'The existing model route requests 700 output tokens and cannot honor a smaller per-turn cap.',
          );
        }
        return validateModelCompletion(
          model.completeWithReceipt
            ? await model.completeWithReceipt(input, signal)
            : {
                text: await model.complete(input, signal),
                receipt: unknownReceipt,
              },
          modelLimits,
        );
      }),
  };
}

export function createZetarisPort(source: EvidenceSource): ZetarisPort {
  return {
    id: source.id,
    mode: 'live',
    retrieve: (scope, context) =>
      runWithExecutionContext(context, async ({ signal }) => {
        const capture = await source.retrieve(scope, signal);
        if (capture.source !== source.id || capture.mode !== 'live') {
          return invalidResponse(
            'Evidence capture does not identify the configured live source.',
          );
        }
        return capture;
      }),
  };
}

export function createUnavailableHMemPort(): HMemPort {
  return {
    id: 'hmem-unavailable',
    recall: (_query, context) =>
      runWithExecutionContext(context, () =>
        Promise.resolve({
          status: 'unavailable',
          reason: 'No H-Mem recall adapter is configured.',
        }),
      ),
    captureReviewedLesson: (_lesson, context) =>
      runWithExecutionContext(context, () =>
        Promise.resolve({
          status: 'disabled',
          reason:
            'Lesson capture is disabled until human eligibility is supplied.',
        }),
      ),
  };
}

export function createUnavailableWorldModelPort(): WorldModelPort {
  return {
    id: 'world-model-unavailable',
    readSnapshot: (_query, context) =>
      runWithExecutionContext(context, () =>
        Promise.resolve({
          status: 'unavailable',
          reason: 'No World Model snapshot adapter is configured.',
        }),
      ),
  };
}

/** Resolution is lazy: missing live credentials fail an attempted turn, not startup. */
export function createLivePorts(
  env: NodeJS.ProcessEnv,
  source?: EvidenceSource,
  model?: AgentModel,
): IntegrationPorts {
  let resolvedModel = model;
  let resolvedSource = source;
  return {
    nightshift: {
      id: 'configured-agent-model',
      mode: 'live',
      get selection() {
        return resolvedModel ? { ...resolvedModel.selection } : undefined;
      },
      execute: (input, context) =>
        runWithExecutionContext(context, (boundedContext) => {
          resolvedModel ??= resolveAgentModel(env);
          return createNightShiftPort(resolvedModel).execute(
            input,
            boundedContext,
          );
        }),
    },
    zetaris: {
      id: source?.id ?? PM25_SOURCE_ID,
      mode: 'live',
      retrieve: (scope, context) =>
        runWithExecutionContext(context, (boundedContext) => {
          resolvedSource ??= resolveEvidenceSource(env);
          return createZetarisPort(resolvedSource).retrieve(
            scope,
            boundedContext,
          );
        }),
    },
    hmem: createUnavailableHMemPort(),
    world: createUnavailableWorldModelPort(),
  };
}
