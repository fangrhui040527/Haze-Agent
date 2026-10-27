import { describe, expect, it } from 'vitest';
import type { Artifact } from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import { smokeLedgerFinalRenderer } from '../../app/capabilities/smokeledger/final-answer.js';

// Synthetic trace only: the renderer copies reviewed findings and shows the sums behind each share.
const content = {
  operation: 'trace_sources',
  scope: {
    town: 'Batu Pahat',
    window: {
      start: '2026-10-24T00:00:00+08:00',
      end: '2026-10-26T00:00:00+08:00',
    },
  },
  run_id: 'haze-trace_sources-x',
  response: {
    run_id: 'haze-trace_sources-x',
    status: 'success',
    mode: 'live',
    output: {
      summary: 'Fires inside mapped concessions: 7.5% [E-aaaaaaaaaa].',
      claims: [
        {
          id: 'c1',
          kind: 'inference',
          text: 'Fires inside mapped concessions: 7.5% (range 6.5%-8.3%) of the smoke signal [E-aaaaaaaaaa].',
          evidence_ids: ['E-aaaaaaaaaa'],
        },
        {
          id: 'c2',
          kind: 'inference',
          text: 'How each share is calculated: a share is a group summed weight divided by all fires summed weight [E-bbbbbbbbbb].',
          evidence_ids: ['E-bbbbbbbbbb'],
        },
        {
          id: 'c3',
          kind: 'inference',
          text: 'Fires on peat: not assessed, because no peat map is loaded [E-bbbbbbbbbb].',
          evidence_ids: ['E-bbbbbbbbbb'],
        },
      ],
      evidence: [],
      limitations: ['Names are leads for verification.'],
    },
    map: {
      shares: { concession: { central: 7.5 }, peat: null },
      method: {
        assumptions: ['The peat factor is an uncalibrated assumption.'],
      },
      arithmetic: [
        {
          wind_speed_scale: 1,
          total_weight: 16699.5,
          concession_weight: 1257.08,
          peat_weight: 0,
          concession_pct: 7.5,
          peat_pct: 0,
        },
      ],
    },
  },
};
const artifact = {
  id: crypto.randomUUID(),
  version: 1,
  sha256: contractHash(content),
  kind: 'smokeledger.trace_sources',
  content,
} as unknown as Artifact;

describe('SmokeLedger final answer', () => {
  it('renders reviewed findings verbatim and the arithmetic behind each share', () => {
    const out = smokeLedgerFinalRenderer.render({
      task: {} as never,
      artifacts: [artifact],
      closure: [artifact],
      reviews: [
        {
          artifact: { id: artifact.id, version: 1, sha256: artifact.sha256 },
          producer_assignment_id: crypto.randomUUID(),
          producer_revision: 1,
          verdict: 'supported',
          limitations: [],
        },
      ],
      services: {} as never,
    });
    const text = JSON.stringify(out.sections);
    expect(out.sections[0]!.lines[0]).toContain(
      'Independent review: supported',
    );
    expect(text).toContain(
      'Fires inside mapped concessions: 7.5% (range 6.5%-8.3%)',
    );
    expect(out.sections[1]).toMatchObject({
      heading: 'How the percentages were calculated',
    });
    expect(text).toContain(
      'concession land 1,257.08 ÷ all fires 16,699.5 = 7.5%',
    );
    // Peat was not assessed, so no peat sum is presented as a result.
    expect(text).not.toContain('peat 0 ÷');
    expect(out.gaps).toEqual([
      'Fires on peat: not assessed, because no peat map is loaded.',
    ]);
    expect(out.limitations).toContain(
      'The peat factor is an uncalibrated assumption.',
    );
  });
});
