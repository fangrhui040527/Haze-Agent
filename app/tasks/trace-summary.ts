import type { TraceRecord } from '../contracts/trace.js';

export const isTraceHighlight = (record: TraceRecord): boolean => {
  if (record.action.includes('.graph.') || record.action.startsWith('attempt_'))
    return /fail|unknown|reject|late|error/.test(record.action);
  return /decision|assign|handoff|review|critique|fail|unknown|reject|late|admit|complete|pause|cancel|resume|restart|result|stop|revision/.test(
    record.action,
  );
};

const inline = (value: string) =>
  value.replace(/[\r\n]+/g, ' ').replace(/`/g, "'");

/** A deterministic view of saved facts; no additional model invocation. */
export function renderTraceSummary(
  records: TraceRecord[],
  totalRecords = records.length,
): string {
  const first = records[0];
  if (!first) return '# Execution trace\n\nNo captured events are available.\n';
  const last = records.at(-1)!;
  const highlights = records.filter(isTraceHighlight);
  return [
    '# Execution trace',
    '',
    `Task: ${first.task_id}`,
    `Run: ${first.run_id}`,
    `Captured records: ${totalRecords}; snapshot cursor: ${last.cursor}.`,
    'Evidence mode: ' +
      [...new Set(records.map((r) => r.provenance.mode))].join(', ') +
      '.',
    '',
    '## Highlights',
    '',
    ...highlights.map((r) => {
      const refs = r.artifacts
        .map((a) => `${a.id}@${a.version} sha256:${a.sha256}`)
        .join(', ');
      const causes = [
        ...r.causes.event_ids,
        r.causes.decision_id,
        r.causes.attempt_id,
        r.causes.message_id,
      ]
        .filter(Boolean)
        .join(', ');
      const replaces = r.supersedes?.event_ids.join(', ');
      return `- ${r.at} [${r.event_id}] ${inline(r.actor)}: ${inline(r.summary)} (${r.status})${r.evidence_verdict ? `; evidence: ${r.evidence_verdict}` : ''}${refs ? `; artifacts: ${refs}` : ''}${causes ? `; causes: ${causes}` : ''}${replaces ? `; replaces: ${replaces}` : ''}`;
    }),
    ...(records.length < totalRecords
      ? [
          '',
          `Showing the latest ${records.length} records. The complete stream is in events.jsonl.`,
        ]
      : []),
    '',
    '## Provenance and limitations',
    '',
    ...[...new Set(records.flatMap((r) => r.provenance.omissions))].map(
      (o) => `- ${inline(o)}`,
    ),
    '- Only saved facts are shown. Missing causal links, confidence, and provider metadata are not inferred.',
    '- Execution acceptance, evidence verdicts, and task outcomes describe separate facts.',
    '- Exported content is sanitized; original artifact references identify the saved evidence, not redacted bytes.',
    '',
  ].join('\n');
}
