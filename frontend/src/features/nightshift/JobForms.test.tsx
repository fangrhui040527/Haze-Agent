import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { jobsReadinessSchema } from '../../../../app/contracts/nightshift.ts';
import { ChainAdmissionForm, candidatePolicyReady } from './JobForms.tsx';

function cloudReadiness() {
  return jobsReadinessSchema.parse({
    schema_version: 'haze.nightshift.jobs.readiness.v1',
    checked_at: '2026-10-27T00:00:00Z',
    cli_available: true,
    schema_compatible: true,
    runtime_reachable: true,
    local_only_enforced: true,
    local_compute_available: false,
    cloud_enforced: true,
    cloud_compute_available: true,
    ready: true,
    runtime_version: '1.2.1',
    adapter_version: 'test',
    schema_hash: 'test',
    can_reconcile: true,
    reason: null,
    cancellation_idempotent: false,
    options: {
      judges: [],
      budgets: [],
      windows: [],
      max_attempts: 16,
      fleets: [],
    },
  });
}

it('admits new cloud chains without a local model while keeping local-only grants blocked', () => {
  const readiness = cloudReadiness();
  expect(candidatePolicyReady(readiness, 'cloud-ok')).toBe(true);
  expect(candidatePolicyReady(readiness, 'local-only')).toBe(false);
  expect(candidatePolicyReady(null, 'cloud-ok')).toBe(false);
  expect(
    candidatePolicyReady({ ...readiness, cloud_enforced: false }, 'cloud-ok'),
  ).toBe(false);

  const markup = renderToStaticMarkup(
    createElement(ChainAdmissionForm, {
      busy: false,
      available: true,
      readiness,
      onSubmit: () => undefined,
    }),
  );
  expect(markup).toContain('<option value="cloud-ok" selected="">');
  expect(markup).toContain('No cloud spend cap');
  expect(markup).toContain('Job, attempt and lifetime limits still apply');
  expect(markup).toMatch(
    /<button[^>]*type="submit"[^>]*>Admit chain<\/button>/u,
  );
  expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Admit chain/u);
});

it('keeps cloud admission blocked when only local compute is ready', () => {
  const readiness = {
    ...cloudReadiness(),
    local_compute_available: true,
    cloud_compute_available: false,
  };
  expect(candidatePolicyReady(readiness, 'cloud-ok')).toBe(false);
  expect(candidatePolicyReady(readiness, 'local-only')).toBe(true);
  const markup = renderToStaticMarkup(
    createElement(ChainAdmissionForm, {
      busy: false,
      available: true,
      readiness,
      onSubmit: () => undefined,
    }),
  );
  expect(markup).toContain('Cloud candidate jobs are unavailable');
  expect(markup).toMatch(/<button[^>]*disabled[^>]*>Admit chain/u);
});
