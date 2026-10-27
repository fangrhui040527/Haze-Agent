import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { agentRoleSchema } from '../../../../app/contracts/capabilities.ts';
import {
  modelReadinessSchema,
  type ModelReadiness,
} from '../../../../app/contracts/model-routes.ts';
import { AgentRouteTable, NightshiftPage } from './NightshiftPage.tsx';
import { fetchModelReadiness } from './readinessApi.ts';

function readiness(): ModelReadiness {
  return modelReadinessSchema.parse({
    version: 1,
    checked_at: '2026-10-27T00:00:00.000Z',
    routes: agentRoleSchema.options.map((role, index) => ({
      role,
      profile: index ? 'inherited' : 'local-candidate',
      route_id: `route-${index}`,
      provider: index ? 'nvidia' : 'nightshift',
      requested_model: index ? 'baseline' : 'candidate-model',
      configured: true,
      schema_compatible: true,
      reachability: index ? 'blocked' : 'reachable',
      live_verified: false,
      role_evaluation: 'unverified',
      policy: 'provider-default',
      reason: index ? 'Server credentials are unavailable.' : null,
    })),
  });
}

it('keeps reachability, schema inspection and role verification distinct for all agents', () => {
  const markup = renderToStaticMarkup(
    createElement(AgentRouteTable, { data: readiness() }),
  );
  for (const role of agentRoleSchema.options) expect(markup).toContain(role);
  expect(markup).toContain('reachable');
  expect(markup).toContain('blocked');
  expect(markup).toContain('Compatible contract');
  expect(markup).toContain('Role evaluation: unverified');
  expect(markup).toContain('Server credentials are unavailable.');
  expect(markup).not.toContain('>Verified<');
  expect(markup).toContain('scope="row"');
});

it('offers manual-only jobs and separate browser observation while loading', () => {
  const markup = renderToStaticMarkup(
    createElement(MemoryRouter, {}, createElement(NightshiftPage)),
  );
  expect(markup).toContain('Inspecting agent routes');
  expect(markup).toContain('Admitted tasks keep their original routes');
  expect(markup).toContain('direct calls have no job-chain spend cap');
  expect(markup).toContain('Submit job');
  expect(markup).toContain('Stop browser observation');
  expect(markup).toContain('zero automatic follow-ups');
  expect(markup).toContain('Local-only');
});

it('reads validated readiness without submitting inference or exposing credentials', async () => {
  const data = readiness();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));
  const signal = new AbortController().signal;
  expect(await fetchModelReadiness(signal, fetcher)).toEqual(data);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/nightshift/readiness', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    redirect: 'error',
  });
  fetcher.mockResolvedValueOnce(
    Response.json({ ...data, credential_ref: 'hidden' }),
  );
  await expect(fetchModelReadiness(signal, fetcher)).rejects.toThrow(
    'unsupported response',
  );
});

it('bounds malformed and oversized readiness responses and sanitizes upstream failures', async () => {
  const signal = new AbortController().signal;
  const fetcher = vi.fn<typeof fetch>();
  fetcher.mockResolvedValueOnce(
    new Response('upstream-secret', { status: 503 }),
  );
  await expect(fetchModelReadiness(signal, fetcher)).rejects.toThrow(
    'readiness is unavailable',
  );
  fetcher.mockResolvedValueOnce(
    new Response('not-json-secret', {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(fetchModelReadiness(signal, fetcher)).rejects.toThrow(
    'returned invalid JSON',
  );
  fetcher.mockResolvedValueOnce(
    new Response(' '.repeat(65537), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(fetchModelReadiness(signal, fetcher)).rejects.toThrow(
    'response limit',
  );
});
