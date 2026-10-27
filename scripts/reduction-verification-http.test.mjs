import assert from 'node:assert/strict';
import test from 'node:test';
import { createReductionVerificationReader } from './reduction-verification-http.mjs';

test('idempotent task replay preserves the exact key and serialized body after HTTP 408', async () => {
  const calls = [];
  const retries = [];
  const read = createReductionVerificationReader({
    retryDelayMs: 0,
    onRetry: (entry) => retries.push(entry),
    fetchImpl: async (_url, options) => {
      calls.push(structuredClone(options));
      return calls.length === 1
        ? new Response('', { status: 408 })
        : Response.json({ task_id: 'same-task' });
    },
  });
  assert.deepEqual(
    await read(
      'http://127.0.0.1',
      '/api/tasks',
      { objective: 'fixture' },
      'fixed-key',
    ),
    { task_id: 'same-task' },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[1].headers['Idempotency-Key'], 'fixed-key');
  assert.equal(retries[0].reason, 'http_408');
});
test('a read retries one transient connection reset', async () => {
  let calls = 0;
  const read = createReductionVerificationReader({
    retryDelayMs: 0,
    fetchImpl: async () => {
      if (++calls === 1)
        throw new Error('fetch failed', { cause: { code: 'ECONNRESET' } });
      return Response.json({ status: 'completed' });
    },
  });
  assert.deepEqual(await read('http://127.0.0.1', '/api/tasks/id'), {
    status: 'completed',
  });
  assert.equal(calls, 2);
});
test('repeated transport failure stops after one retry', async () => {
  let calls = 0;
  const read = createReductionVerificationReader({
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls++;
      throw new Error('fetch failed', { cause: { code: 'ECONNRESET' } });
    },
  });
  await assert.rejects(
    read('http://127.0.0.1', '/api/tasks/id'),
    /Verification request failed/,
  );
  assert.equal(calls, 2);
});
test('malformed successful responses are diagnosed rather than retried', async () => {
  let calls = 0;
  const read = createReductionVerificationReader({
    fetchImpl: async () => {
      calls++;
      return new Response('', { status: 200 });
    },
  });
  await assert.rejects(
    read('http://127.0.0.1', '/api/tasks/id'),
    /HTTP 200, 0 bytes/,
  );
  assert.equal(calls, 1);
});
test('validation failures are not retried', async () => {
  let calls = 0;
  const read = createReductionVerificationReader({
    fetchImpl: async () => {
      calls++;
      return Response.json({ error: 'validation' }, { status: 422 });
    },
  });
  await assert.rejects(read('http://127.0.0.1', '/api/tasks', {}), /HTTP 422/);
  assert.equal(calls, 1);
});
test('an unknown mutation endpoint is never automatically replayed', async () => {
  let calls = 0;
  const read = createReductionVerificationReader({
    fetchImpl: async () => {
      calls++;
      throw new Error('fetch failed', { cause: { code: 'ECONNRESET' } });
    },
  });
  await assert.rejects(
    read('http://127.0.0.1', '/api/unknown', {}),
    /Verification request failed/,
  );
  assert.equal(calls, 1);
});
