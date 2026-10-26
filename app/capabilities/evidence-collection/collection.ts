import { createHash } from 'node:crypto';
import type { AdapterContext, AdapterResult, SourceAdapter } from './types.js';

/**
 * Collect one source snapshot without owning timers or storage. Callers retain
 * the returned evidence through their own dashboard store or task services.
 */
export async function collectOnce(
  adapter: SourceAdapter,
  context: AdapterContext,
): Promise<AdapterResult> {
  context.signal.throwIfAborted();
  const result = await adapter.run(context);
  // A provider may finish after cancellation. Do not hand that work to a sink.
  context.signal.throwIfAborted();
  const evidenceIds = new Set<string>();
  for (const { record, raw } of result.evidence) {
    const hash = createHash('sha256').update(raw).digest('hex');
    if (record.rawSha256 !== hash || record.rawBytes !== raw.length)
      throw new Error(
        'Collected evidence does not match its pinned raw bytes.',
      );
    if (
      record.acceptedAt !== null ||
      record.disposition !== 'pinned_unreviewed'
    )
      throw new Error('Evidence collection cannot grant acceptance or review.');
    evidenceIds.add(record.evidenceId);
  }
  for (const fact of result.facts) {
    if (!evidenceIds.has(fact.evidenceId))
      throw new Error('Collected fact has no corresponding pinned evidence.');
  }
  return result;
}
