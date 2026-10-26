import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  worldAcceptanceOutcomeSchema,
  type WorldAcceptanceOutcome,
} from '../../../../app/contracts/world.ts';
import {
  worldRecordDetailResponseSchema,
  type WorldRecordDetailResponse,
} from '../../../../app/contracts/world-api.ts';
import { RecordOverview } from './WorldModelRecord.tsx';
import { ReferenceSandbox } from './WorldModelPage.tsx';

const at = '2026-10-26T00:00:00.000Z';
const taskId = '11111111-1111-4111-8111-111111111111';
const sha256 = 'a'.repeat(64);
const recordRef = { id: 'wmr:evidence:1', revision: 2, sha256 };
const scope = { principal: 'local', workspace: 'default', mode: 'fixture' };

function detail(
  acceptances: WorldAcceptanceOutcome[] = [],
): WorldRecordDetailResponse {
  return worldRecordDetailResponseSchema.parse({
    schema_version: 'haze.world.record-detail.v1',
    record: {
      schema_version: 'haze.world.record.v1',
      ref: recordRef,
      scope,
      kind: 'evidence_snapshot',
      payload: { task_id: taskId, title: 'Retained evidence' },
      producer: { kind: 'service', id: 'research' },
      observed_at: at,
      retrieved_at: at,
      recorded_at: at,
    },
    relationships: [],
    support_artifacts: [],
    payload: { task_id: taskId, title: 'Retained evidence' },
    status: {
      schema_version: 'haze.world.current-status.v1',
      record_id: recordRef.id,
      acceptances,
    },
  });
}

function acceptance(status: WorldAcceptanceOutcome['status']) {
  const base = {
    schema_version: 'haze.world.acceptance.v1',
    id: `acceptance:${status}`,
    scope,
    subject: recordRef,
    stated_use: `Research use for ${status}`,
    policy: { id: 'research-policy', version: '3', sha256 },
    support_revisions: [],
    evaluated_at: at,
    expires_at: '2026-10-27T00:00:00.000Z',
  };
  return worldAcceptanceOutcomeSchema.parse(
    status === 'accepted'
      ? { ...base, status, accepted_at: at }
      : status === 'pending_review'
        ? {
            ...base,
            status,
            reasons: ['Independent review is still required.'],
          }
        : status === 'not_eligible'
          ? {
              ...base,
              status,
              reasons: ['The source does not cover this use.'],
            }
          : status === 'held'
            ? { ...base, status, hold_ids: ['hold:source-correction'] }
            : {
                ...base,
                status,
                superseded_by: {
                  ...recordRef,
                  id: 'wmr:evidence:replacement',
                  revision: 3,
                },
              },
  );
}

const renderOverview = (value: WorldRecordDetailResponse) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(RecordOverview, { detail: value }),
    ),
  );

describe('World Model record overview', () => {
  it('renders every current acceptance state with its stated use and policy', () => {
    const statuses = [
      'accepted',
      'pending_review',
      'not_eligible',
      'held',
      'superseded',
    ] as const;
    const markup = renderOverview(detail(statuses.map(acceptance)));
    for (const status of statuses) {
      expect(markup).toContain(`data-status="${status}"`);
      expect(markup).toContain(`Research use for ${status}`);
    }
    for (const label of [
      'Accepted for stated use',
      'Pending review',
      'Not eligible',
      'Held',
      'Superseded',
    ])
      expect(markup).toContain(label);
    expect(markup).toContain('research-policy');
    expect(markup).toContain('Independent review is still required.');
    expect(markup).toContain('The source does not cover this use.');
    expect(markup).toContain('Hold references: hold:source-correction');
    expect(markup).toContain('wmr:evidence:replacement');
    expect(markup).toContain('Valid until');
    expect(markup).toContain('dateTime="2026-10-27T00:00:00.000Z"');
  });

  it('states that a retained record without an acceptance decision is not approved', () => {
    const markup = renderOverview(detail());
    expect(markup).toContain('No acceptance decision.');
    expect(markup).toContain(
      'A retained record alone does not establish review or approval.',
    );
    expect(markup).not.toContain('data-status="accepted"');
    expect(markup).not.toContain('Accepted for stated use');
  });

  it('links the exact originating task from retained task identity', () => {
    const markup = renderOverview(detail());
    expect(markup).toContain(`href="/task/${taskId}"`);
    expect(markup).toContain('Open originating task');
    expect(markup).toContain('request a correction in its task report');
  });

  it('omits the task link when a record has no valid task identity', () => {
    const value = detail();
    value.record.payload = { task_id: 'javascript:alert(1)' };
    const markup = renderOverview(value);
    expect(markup).not.toContain('Open originating task');
    expect(markup).not.toContain('href="javascript:');
  });

  it('renders hostile retained content and acceptance text as escaped text', () => {
    const outcome = acceptance('pending_review');
    outcome.stated_use = '<script>alert("stated use")</script>';
    if (outcome.status === 'pending_review')
      outcome.reasons = ['<img src=x onerror=alert(1)>'];
    const value = detail([outcome]);
    value.payload = { evidence: '<script>alert("payload")</script>' };
    const markup = renderOverview(value);
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img ');
  });

  it('exposes pinned supporting artifacts with encoded IDs and content hashes', () => {
    const value = detail();
    value.support_artifacts = [
      {
        id: 'artifact:source/1',
        version: 2,
        sha256,
      },
    ];
    const markup = renderOverview(value);
    expect(markup).toContain('Supporting artifacts');
    expect(markup).toContain('href="/api/artifacts/artifact%3Asource%2F1"');
    expect(markup).toContain(sha256);
    expect(markup).toContain('rel="noreferrer"');
  });
});

describe('Meterless reference sandbox', () => {
  it('embeds the vendored sample UI with scripts as its only sandbox capability', () => {
    const markup = renderToStaticMarkup(createElement(ReferenceSandbox));
    const iframe = markup.match(/<iframe\b[^>]*>/u)?.[0];
    expect(iframe).toBeDefined();
    expect(iframe).toContain('src="/meterless-world-model/live.html"');
    expect(iframe).toContain('title="Meterless World Model reference sandbox"');
    expect(iframe).toContain('sandbox="allow-scripts"');
    expect(iframe).toContain('referrerPolicy="no-referrer"');
    expect(iframe).not.toContain('allow-same-origin');
    expect(iframe).not.toContain('allow-top-navigation');
    expect(iframe).not.toContain('allow-popups');
  });

  it('clearly separates disposable reference sample data from Haze records', () => {
    const markup = renderToStaticMarkup(createElement(ReferenceSandbox));
    expect(markup).toContain('Sample data');
    expect(markup).toContain('disposable');
    expect(markup).toContain('original engine with sample data');
    expect(markup).toContain('Changes stay in this sandbox');
    expect(markup).toContain('reset when it is reopened');
    expect(markup).toContain('Your Haze records are separate.');
  });
});
