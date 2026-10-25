import type { AgentModelInput } from '../adapters/agent-model.js';
import type { EvidenceScope } from '../tasks/evidence.js';
import {
  validateEnrichmentResult,
  validateModelCompletion,
  validateModelInput,
  type ExecutionContext,
  type HMemPort,
  type NightShiftPort,
  type WorldModelPort,
  type ZetarisPort,
} from './ports.js';

function requireContract(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) throw new Error(`integration_conformance: ${message}`);
}

async function assertCancelled(
  context: ExecutionContext,
  invoke: (cancelled: ExecutionContext) => Promise<unknown>,
): Promise<void> {
  const controller = new AbortController();
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => invoke({ ...context, signal: controller.signal }))
        .then(
          () => 'accepted',
          () => 'rejected',
        ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('unresponsive'), 1000);
      }),
    ]);
    requireContract(
      outcome === 'rejected',
      'pre-cancelled work must reject promptly',
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Deliberately issues one successful call; callers choose fixture or live inputs. */
export async function assertNightShiftConformance(
  port: NightShiftPort,
  input: AgentModelInput,
  context: ExecutionContext,
): Promise<void> {
  requireContract(
    Boolean(port.id.trim()),
    'model adapter must identify itself',
  );
  requireContract(
    ['live', 'fixture'].includes(port.mode),
    'execution mode is explicit',
  );
  await assertCancelled(context, (cancelled) => port.execute(input, cancelled));
  validateModelInput(input, context.modelLimits);
  if (port.selection) {
    requireContract(
      Boolean(port.selection.provider.trim() && port.selection.model.trim()),
      'configured route requires provider and model names',
    );
  }
  validateModelCompletion(
    await port.execute(input, context),
    context.modelLimits,
  );
}

export async function assertZetarisConformance(
  port: ZetarisPort,
  scope: EvidenceScope,
  context: ExecutionContext,
): Promise<void> {
  requireContract(
    Boolean(port.id.trim()),
    'evidence adapter must identify itself',
  );
  requireContract(
    ['live', 'fixture'].includes(port.mode),
    'execution mode is explicit',
  );
  await assertCancelled(context, (cancelled) =>
    port.retrieve(scope, cancelled),
  );
  const capture = await port.retrieve(scope, context);
  requireContract(
    capture.source === port.id,
    'capture source must match adapter',
  );
  requireContract(
    capture.location === scope.location,
    'capture must match requested location',
  );
  requireContract(Boolean(capture.raw), 'exact raw evidence must be retained');
  requireContract(
    Boolean(capture.selection.request_id),
    'selection requires a request receipt',
  );
  requireContract(
    capture.selection.selected_raw_row_indices.length === capture.rows.length,
    'selected rows require raw-row linkage',
  );
  requireContract(
    capture.rows.every(
      (row) =>
        Date.parse(row.start) >= Date.parse(scope.period.start) &&
        Date.parse(row.start) < Date.parse(scope.period.end),
    ),
    'samples must remain within requested period',
  );
}

export async function assertEnrichmentConformance(
  port: HMemPort | WorldModelPort,
  query: string,
  context: ExecutionContext,
): Promise<void> {
  requireContract(
    Boolean(port.id.trim()),
    'enrichment adapter must identify itself',
  );
  const read = (value: ExecutionContext) =>
    'recall' in port
      ? port.recall(query, value)
      : port.readSnapshot(query, value);
  await assertCancelled(context, read);
  validateEnrichmentResult(await read(context));
}
