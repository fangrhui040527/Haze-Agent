import { z } from 'zod';
import type { FinalRenderer } from '../../orchestration/ports.js';
import { finalAnswerFormat as format } from '../../orchestration/final-answer.js';
import { runToolOutputSchema } from './contracts.js';

const arithmeticSchema = z.array(
  z.looseObject({
    wind_speed_scale: z.number(),
    total_weight: z.number(),
    concession_weight: z.number(),
    peat_weight: z.number(),
    concession_pct: z.number(),
    peat_pct: z.number(),
  }),
);
const methodSchema = z.looseObject({
  assumptions: z.array(z.string()).default([]),
});
const mapSchema = z.looseObject({
  arithmetic: arithmeticSchema.optional(),
  method: methodSchema.optional(),
  shares: z
    .looseObject({
      concession: z.unknown().nullable().optional(),
      peat: z.unknown().nullable().optional(),
    })
    .optional(),
});

const weight = (x: number) =>
  x.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * The saved SmokeLedger answer is the reviewed findings verbatim (each already
 * checked by the judge against its cited query), followed by the arithmetic behind
 * every share so a reader can redo it. The Manager's prose is never the answer.
 */
export const smokeLedgerFinalRenderer: FinalRenderer = {
  artifact_kinds: ['smokeledger.trace_sources', 'smokeledger.air_outlook'],
  render({ artifacts, reviews }) {
    const sections: ReturnType<FinalRenderer['render']>['sections'] = [];
    const limitations: string[] = [];
    const gaps: string[] = [];
    for (const artifact of artifacts) {
      const run = runToolOutputSchema.parse(artifact.content);
      const { response, scope } = run;
      const review = format.review(reviews, artifact);
      const trace = run.operation === 'trace_sources';
      const where = `${scope.town}, ${scope.window.start} to ${scope.window.end} (end exclusive)`;
      const claims = response.output?.claims ?? [];
      if (response.status === 'error' || !response.output) {
        const reason =
          response.error?.message ?? 'SmokeLedger returned no result.';
        gaps.push(reason);
        sections.push({
          heading: `${trace ? 'Smoke source trace' : 'Air outlook'}: ${where}`,
          lines: [reason],
        });
        continue;
      }
      sections.push({
        heading: `${trace ? 'Where the smoke came from' : 'Air outlook'}: ${where}`,
        lines: [
          `Independent review: ${review?.verdict ?? 'not recorded'}. EvidenceCritic re-ran every cited query (ids like [E-…] below) and a model judge checked each sentence against the rows it cites.`,
          ...claims
            .filter((claim) => !/^How each share is calculated/.test(claim.text))
            .map((claim) => claim.text),
        ],
      });
      if (trace) {
        const map = mapSchema.safeParse(
          (response as Record<string, unknown>)['map'],
        );
        const how = claims.find((claim) =>
          /^How each share is calculated/.test(claim.text),
        );
        const sums = map.success ? (map.data.arithmetic ?? []) : [];
        const concession = map.success && map.data.shares?.concession;
        const peat = map.success && map.data.shares?.peat;
        if (how || sums.length)
          sections.push({
            heading: 'How the percentages were calculated',
            lines: [
              ...(how ? [how.text.replace(/^How each share is calculated: /, '')] : []),
              ...sums.map(
                (row) =>
                  `Wind speed ×${row.wind_speed_scale}${row.wind_speed_scale === 1 ? ' (headline)' : ''}: ` +
                  [
                    concession
                      ? `concession land ${weight(row.concession_weight)} ÷ all fires ${weight(row.total_weight)} = ${row.concession_pct}%`
                      : null,
                    peat
                      ? `peat ${weight(row.peat_weight)} ÷ ${weight(row.total_weight)} = ${row.peat_pct}%`
                      : null,
                  ]
                    .filter(Boolean)
                    .join('; ') +
                  '.',
              ),
              ...(sums.length
                ? [
                    'The headline share uses ×1; the range is the lowest and highest of the three wind speeds. Open the task report to click any fire and see its own factors.',
                  ]
                : []),
            ],
          });
        if (map.success) limitations.push(...(map.data.method?.assumptions ?? []));
      }
      for (const claim of claims)
        if (/\bnot assessed\b/i.test(claim.text))
          gaps.push(claim.text.replace(/\s*\[E-[0-9a-f]{10}\]/g, ''));
      for (const interval of response.output.validity?.unserved ?? [])
        gaps.push(`Not covered: ${interval}.`);
      limitations.push(
        ...(response.output.limitations ?? []),
        ...(review?.limitations ?? []),
      );
    }
    return { sections, limitations, gaps };
  },
};
