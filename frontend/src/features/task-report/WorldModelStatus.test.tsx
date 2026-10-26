import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  worldAcceptanceOutcomeSchema,
  worldRecordSchema,
} from '../../../../app/contracts/world.ts';
import { worldTaskResponseSchema } from '../../../../app/contracts/world-api.ts';
import { taskId } from '../../services/agents/testFixtures.ts';
import { WorldModelStatus } from './WorldModelStatus.tsx';

const timestamp = '2026-01-01T00:00:00.000Z';
const digest = 'a'.repeat(64);
const statuses = [
  'accepted',
  'pending_review',
  'held',
  'superseded',
  'not_eligible',
] as const;

function worldTaskResponse() {
  const records = statuses.map((_, index) =>
    worldRecordSchema.parse({
      schema_version: 'haze.world.record.v1',
      ref: { id: `record-${index}`, revision: 1, sha256: digest },
      scope: { principal: 'local-user', workspace: 'workspace', mode: 'live' },
      kind: 'evidence_snapshot',
      payload: { limitations: ['Limited to the stated scope.'] },
      producer: { kind: 'service', id: 'research' },
      recorded_at: timestamp,
    }),
  );
  const current_acceptances = statuses.map((status, index) => {
    const common = {
      schema_version: 'haze.world.acceptance.v1',
      id: `acceptance-${index}`,
      scope: records[index].scope,
      subject: records[index].ref,
      stated_use: 'current research',
      policy: { id: 'research-policy', version: '1', sha256: digest },
      support_revisions: [],
      evaluated_at: timestamp,
    };
    const outcome =
      status === 'accepted'
        ? { ...common, status, accepted_at: timestamp }
        : status === 'pending_review' || status === 'not_eligible'
          ? { ...common, status, reasons: ['A required review is missing.'] }
          : status === 'held'
            ? { ...common, status, hold_ids: ['hold-1'] }
            : {
                ...common,
                status,
                superseded_by: {
                  id: 'record-replacement',
                  revision: 2,
                  sha256: digest,
                },
              };
    return {
      subject: records[index].ref.id,
      acceptance: worldAcceptanceOutcomeSchema.parse(outcome),
    };
  });
  return worldTaskResponseSchema.parse({
    schema_version: 'haze.world.task-view.v1',
    task_id: taskId,
    mode: 'live',
    records,
    current_acceptances,
    truncated: false,
  });
}

const render = (state: {
  data: ReturnType<typeof worldTaskResponseSchema.parse> | null;
  loading: boolean;
  error: string | null;
}) => renderToStaticMarkup(createElement(WorldModelStatus, { state }));

describe('World Model status panel', () => {
  it('shows current acceptance states and record limitations', () => {
    const markup = render({
      data: worldTaskResponse(),
      loading: false,
      error: null,
    });

    expect(markup).toContain('Accepted for stated use');
    expect(markup).toContain('Pending review');
    expect(markup).toContain('Held');
    expect(markup).toContain('Superseded');
    expect(markup).toContain('Not eligible');
    expect(markup).toContain('A required review is missing.');
    expect(markup).toContain('Hold references: hold-1');
    expect(markup).toContain('record-replacement');
    expect(markup).toContain('Limitations: Limited to the stated scope.');
  });

  it('keeps load failures and empty task status explicit', () => {
    expect(
      render({ data: null, loading: false, error: 'Request failed (503).' }),
    ).toContain('role="alert">Current World Model status is unavailable');
    expect(render({ data: null, loading: true, error: null })).toContain(
      'Loading current World Model status...',
    );
    expect(
      render({
        data: worldTaskResponseSchema.parse({
          schema_version: 'haze.world.task-view.v1',
          task_id: taskId,
          mode: 'live',
          records: [],
          current_acceptances: [],
          truncated: false,
        }),
        loading: false,
        error: null,
      }),
    ).toContain('No World Model records are linked to this task.');
  });
});
