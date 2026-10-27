import type { IncomingMessage } from 'node:http';
import { TaskError, type TaskIdentity } from '../contracts/tasks.js';

/** This surface handles only local authenticated HTTP. Policy lives in the service. */
export interface NightshiftHttpService {
  readiness: (identity: TaskIdentity) => unknown;
  automationReadiness?: (identity: TaskIdentity) => unknown;
  chainAutomation?: (id: string, identity: TaskIdentity) => unknown;
  proposeProgress?: (
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ) => unknown;
  admitChain: (value: unknown, key: string, identity: TaskIdentity) => unknown;
  listChains: (identity: TaskIdentity) => unknown;
  chain: (id: string, identity: TaskIdentity) => unknown;
  controlChain: (
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ) => unknown;
  submitJob: (value: unknown, key: string, identity: TaskIdentity) => unknown;
  listJobs: (identity: TaskIdentity) => unknown;
  job: (id: string, identity: TaskIdentity) => unknown;
  cancelJob: (
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ) => unknown;
  reconcileJob: (
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ) => unknown;
  selectResult: (
    id: string,
    value: unknown,
    key: string,
    identity: TaskIdentity,
  ) => unknown;
  events: (id: string, after: number, identity: TaskIdentity) => unknown;
}

export async function handleNightshiftHttp({
  request,
  url,
  identity,
  service,
  externalWaitView,
  readBody,
  idempotencyKey,
  send,
}: {
  request: IncomingMessage;
  url: URL;
  identity: TaskIdentity;
  service: NightshiftHttpService;
  externalWaitView?: (taskId: string, identity: TaskIdentity) => unknown;
  readBody: (request: IncomingMessage, maximum: number) => Promise<unknown>;
  idempotencyKey: (request: IncomingMessage) => string;
  send: (status: number, value: unknown) => void;
}): Promise<boolean> {
  if (!url.pathname.startsWith('/api/nightshift/')) return false;
  const relative = url.pathname.slice('/api/nightshift/'.length);
  const eventMatch = /^jobs\/([A-Za-z0-9-]{1,128})\/events$/u.exec(relative);
  const allowedQuery = eventMatch ? ['after'] : [];
  for (const key of url.searchParams.keys()) {
    if (
      !allowedQuery.includes(key) ||
      url.searchParams.getAll(key).length !== 1
    )
      throw new TaskError(
        400,
        'invalid_query',
        'Unsupported or duplicate query key.',
      );
  }
  const method = request.method;
  if (relative === 'automation/readiness') {
    if (method !== 'GET')
      throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
    if (!service.automationReadiness)
      throw new TaskError(
        503,
        'automatic_chain_view_unavailable',
        'Automatic chain readiness is unavailable on this server.',
      );
    send(200, await service.automationReadiness(identity));
    return true;
  }
  const automationMatch = /^chains\/([A-Za-z0-9-]{1,128})\/automation$/u.exec(
    relative,
  );
  if (automationMatch) {
    if (method !== 'GET')
      throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
    if (!service.chainAutomation)
      throw new TaskError(
        503,
        'automatic_chain_view_unavailable',
        'Automatic chain readback is unavailable on this server.',
      );
    send(200, await service.chainAutomation(automationMatch[1]!, identity));
    return true;
  }
  const progressMatch = /^chains\/([A-Za-z0-9-]{1,128})\/progress$/u.exec(
    relative,
  );
  if (progressMatch) {
    if (method !== 'POST')
      throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
    if (!service.proposeProgress)
      throw new TaskError(
        503,
        'automatic_chain_view_unavailable',
        'Chain progress proposals are unavailable on this server.',
      );
    const key = idempotencyKey(request);
    const body = await readBody(request, 65_536);
    send(
      200,
      await service.proposeProgress(progressMatch[1]!, body, key, identity),
    );
    return true;
  }
  const waitMatch = /^tasks\/([A-Za-z0-9-]{1,128})\/waits$/u.exec(relative);
  if (waitMatch) {
    if (method !== 'GET')
      throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
    if (!externalWaitView)
      throw new TaskError(
        503,
        'external_wait_view_unavailable',
        'External wait readback is unavailable on this server.',
      );
    send(200, await externalWaitView(waitMatch[1]!, identity));
    return true;
  }
  if (relative === 'jobs/readiness') {
    if (method !== 'GET')
      throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
    send(200, await service.readiness(identity));
    return true;
  }
  if (relative === 'chains' || relative === 'jobs') {
    if (method === 'GET') {
      send(
        200,
        await (relative === 'chains'
          ? service.listChains(identity)
          : service.listJobs(identity)),
      );
      return true;
    }
    if (method !== 'POST')
      throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
    const key = idempotencyKey(request);
    const body = await readBody(request, 65_536);
    send(
      relative === 'jobs' ? 202 : 201,
      await (relative === 'chains'
        ? service.admitChain(body, key, identity)
        : service.submitJob(body, key, identity)),
    );
    return true;
  }
  if (eventMatch) {
    if (method !== 'GET')
      throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
    const cursor = url.searchParams.get('after') ?? '0';
    if (!/^\d{1,15}$/u.test(cursor) || !Number.isSafeInteger(Number(cursor)))
      throw new TaskError(
        400,
        'invalid_cursor',
        'Use a nonnegative integer cursor.',
      );
    send(200, await service.events(eventMatch[1]!, Number(cursor), identity));
    return true;
  }
  const match =
    /^(chains|jobs)\/([A-Za-z0-9-]{1,128})(?:\/(control|cancel|reconcile|select))?$/u.exec(
      relative,
    );
  if (!match)
    throw new TaskError(
      404,
      'route_not_found',
      'Nightshift API route not found.',
    );
  const kind = match[1]!;
  const id = match[2]!;
  const action = match[3];
  if (!action) {
    if (method !== 'GET')
      throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
    send(
      200,
      await (kind === 'chains'
        ? service.chain(id, identity)
        : service.job(id, identity)),
    );
    return true;
  }
  if (
    (kind === 'chains' && action !== 'control') ||
    (kind === 'jobs' && action === 'control')
  )
    throw new TaskError(
      404,
      'route_not_found',
      'Nightshift API route not found.',
    );
  if (method !== 'POST')
    throw new TaskError(405, 'method_not_allowed', 'Method not allowed.');
  const key = idempotencyKey(request);
  const body = await readBody(request, 65_536);
  const result =
    kind === 'chains'
      ? await service.controlChain(id, body, key, identity)
      : action === 'cancel'
        ? await service.cancelJob(id, body, key, identity)
        : action === 'reconcile'
          ? await service.reconcileJob(id, body, key, identity)
          : await service.selectResult(id, body, key, identity);
  send(200, result);
  return true;
}
