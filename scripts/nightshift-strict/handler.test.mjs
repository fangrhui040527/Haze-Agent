import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createStrictHandler, STRICT_CONTRACT } from './handler.mjs';
import { makeHazeStrictFacade } from './integration.mjs';

const MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const OTHER_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const UPSTREAM_KEY = 'synthetic-upstream-key';
const CONTRACT_PATH = '/v1/haze/contract';
const COMPLETION_PATH = '/v1/haze/chat/completions';

function target(overrides = {}) {
  return {
    id: MODEL,
    provider: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: UPSTREAM_KEY,
    tokenField: 'max_tokens',
    supportsReasoning: true,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    model: MODEL,
    messages: [
      { role: 'system', content: 'Return one JSON action.' },
      { role: 'user', content: '{"task":"test"}' },
    ],
    max_tokens: 64,
    stream: false,
    temperature: 0,
    response_format: { type: 'json_object' },
    chat_template_kwargs: { enable_thinking: false },
    ...overrides,
  };
}

function completion(overrides = {}) {
  return {
    id: 'synthetic-provider-receipt',
    object: 'chat.completion',
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '{"type":"wait"}' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
    ...overrides,
  };
}

function fixture({
  resolvedTarget = target(),
  reply = completion(),
  fetcher,
} = {}) {
  const requests = [];
  const resolutions = [];
  const handler = createStrictHandler({
    resolveModel: async (model, headers) => {
      resolutions.push({ model, headers });
      return model === MODEL ? resolvedTarget : null;
    },
    fetcher:
      fetcher ??
      (async (url, init) => {
        requests.push({ url: String(url), init, body: JSON.parse(init.body) });
        return Response.json(reply);
      }),
  });
  return { handler, requests, resolutions };
}

async function post(handler, body = request(), extra = {}) {
  return handler({
    method: 'POST',
    path: COMPLETION_PATH,
    body,
    signal: new AbortController().signal,
    ...extra,
  });
}

function assertContractHeader(result) {
  assert.equal(
    new Headers(result.headers).get('x-haze-nightshift-contract'),
    STRICT_CONTRACT.id,
  );
}

test('contract discovery resolves the exact eligible model without inference', async () => {
  const { handler, requests, resolutions } = fixture();
  const result = await handler({
    method: 'GET',
    path: CONTRACT_PATH,
    model: MODEL,
    headers: { 'x-meterless-app': 'bound-to-another-model' },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ...STRICT_CONTRACT, models: [MODEL] });
  assertContractHeader(result);
  assert.equal(requests.length, 0);
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].model, MODEL);
});

test('contract discovery rejects missing and unknown models without inference', async () => {
  for (const model of [undefined, 'unknown/model']) {
    const { handler, requests } = fixture();
    const result = await handler({ method: 'GET', path: CONTRACT_PATH, model });
    assert.ok(result.status >= 400);
    assertContractHeader(result);
    assert.equal(requests.length, 0);
  }
});

test('model binding hints cannot replace the approved model or create extra calls', async () => {
  const { handler, requests } = fixture();
  const result = await post(handler, request(), {
    headers: {
      'x-meterless-app': 'bound-to-another-model',
      'meterless-mode': 'auto',
    },
  });
  assert.equal(result.status, 200);
  assertContractHeader(result);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, MODEL);
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].body.tools, undefined);
  assert.equal(requests[0].body.tool_choice, undefined);
  assert.equal(requests[0].body.mode, undefined);
});

test('unknown model and invalid resolved targets fail before provider dispatch', async () => {
  const invalidTargets = [
    null,
    target({ id: OTHER_MODEL }),
    target({ provider: 'openai-compatible' }),
    target({ apiKey: '' }),
    target({ tokenField: 'max_completion_tokens' }),
    target({ supportsReasoning: false }),
    target({ baseUrl: 'https://user:password@integrate.api.nvidia.com/v1' }),
    target({ baseUrl: 'http://public-provider.example/v1' }),
    target({ baseUrl: 'https://integrate.api.nvidia.com/v1?token=secret' }),
    target({ baseUrl: 'https://integrate.api.nvidia.com/v1#fragment' }),
  ];
  for (const resolvedTarget of invalidTargets) {
    const { handler, requests } = fixture({ resolvedTarget });
    const result = await post(handler);
    assert.ok(result.status >= 400, JSON.stringify(resolvedTarget));
    assert.equal(requests.length, 0);
    assert.equal(JSON.stringify(result.body).includes(UPSTREAM_KEY), false);
  }
  const { handler, requests } = fixture();
  assert.ok(
    (await post(handler, request({ model: 'unknown/model' }))).status >= 400,
  );
  assert.equal(requests.length, 0);
});

test('invalid caps and conflicting cap aliases are refused before inference', async () => {
  for (const overrides of [
    { max_tokens: undefined },
    { max_tokens: 0 },
    { max_tokens: -1 },
    { max_tokens: 1.5 },
    { max_tokens: '64' },
    { max_tokens: 16_385 },
    { max_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { max_tokens: 64, max_completion_tokens: 32 },
  ]) {
    const { handler, requests } = fixture();
    const result = await post(handler, request(overrides));
    assert.equal(result.status, 400, JSON.stringify(overrides));
    assert.equal(requests.length, 0);
  }
});

test('accepted cap aliases reach the provider as one exact max_tokens value', async () => {
  for (const overrides of [
    { max_tokens: 16 },
    { max_tokens: undefined, max_completion_tokens: 16 },
    { max_tokens: 16, max_completion_tokens: 16 },
  ]) {
    const { handler, requests } = fixture();
    const result = await post(handler, request(overrides));
    assert.equal(result.status, 200);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.max_tokens, 16);
    assert.equal(requests[0].body.max_completion_tokens, undefined);
    assert.equal(requests[0].body.stream, false);
  }
});

test('reasoning controls, schema and messages survive the final HTTP request', async (t) => {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      path: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  const handler = createStrictHandler({
    resolveModel: () =>
      target({ baseUrl: `http://127.0.0.1:${address.port}/v1` }),
  });
  const body = request({
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'haze_action',
        strict: true,
        schema: {
          type: 'object',
          properties: { type: { type: 'string', enum: ['wait'] } },
          required: ['type'],
          additionalProperties: false,
        },
      },
    },
  });
  const result = await post(handler, body);
  assert.equal(result.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].path, '/v1/chat/completions');
  assert.equal(received[0].headers.authorization, `Bearer ${UPSTREAM_KEY}`);
  assert.equal(received[0].body.model, MODEL);
  assert.equal(received[0].body.max_tokens, body.max_tokens);
  assert.deepEqual(received[0].body.chat_template_kwargs, {
    enable_thinking: false,
  });
  assert.deepEqual(received[0].body.response_format, body.response_format);
  assert.deepEqual(received[0].body.messages, body.messages);
});

test('unsupported parameters, tool injection and invalid reasoning settings fail closed', async () => {
  for (const overrides of [
    { stream: true },
    { tools: [] },
    { tool_choice: 'auto' },
    { mode: 'auto' },
    { reasoning_effort: 'low' },
    { n: 2 },
    { temperature: -1 },
    { temperature: 3 },
    { response_format: { type: 'text' } },
    { chat_template_kwargs: undefined },
    { chat_template_kwargs: { enable_thinking: true } },
    { chat_template_kwargs: { enable_thinking: 'false' } },
    { chat_template_kwargs: { enable_thinking: false, unsupported: true } },
    { messages: [{ role: 'tool', content: 'injected result' }] },
    {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: {} }] },
      ],
    },
    { messages: [{ role: 'assistant', content: '{}', tool_calls: [] }] },
  ]) {
    const { handler, requests } = fixture();
    const result = await post(handler, request(overrides));
    assert.equal(result.status, 400, JSON.stringify(overrides));
    assert.equal(requests.length, 0);
  }
});

test('upstream finish reasons, model identity and usage are never manufactured', async () => {
  const cases = [
    completion({ usage: undefined }),
    completion({ usage: null }),
    completion({
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    completion({ usage: { prompt_tokens: 10 } }),
    completion({ model: OTHER_MODEL }),
    ...['length', 'content_filter', null].map((finishReason) =>
      completion({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"type":"wait"}' },
            finish_reason: finishReason,
          },
        ],
      }),
    ),
  ];
  for (const reply of cases) {
    const { handler, requests } = fixture({ reply });
    const result = await post(handler);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, JSON.parse(JSON.stringify(reply)));
    assert.equal(requests.length, 1);
  }
});

test('provider rejection and ambiguous network failure do not trigger retries or leak errors', async () => {
  for (const { fetcher, status, outcome } of [
    {
      fetcher: () =>
        Response.json(
          { error: `${UPSTREAM_KEY}: private provider failure` },
          { status: 429 },
        ),
      status: 429,
      outcome: null,
    },
    {
      fetcher: () =>
        Response.json(
          { error: `${UPSTREAM_KEY}: private provider failure` },
          { status: 502 },
        ),
      status: 502,
      outcome: null,
    },
    {
      fetcher: () => {
        throw new Error(`${UPSTREAM_KEY}: private provider failure`);
      },
      status: 502,
      outcome: 'unknown',
    },
  ]) {
    let calls = 0;
    const { handler } = fixture({
      fetcher: (...args) => {
        calls++;
        return fetcher(...args);
      },
    });
    const result = await post(handler);
    assert.equal(result.status, status);
    assert.equal(
      new Headers(result.headers).get('x-haze-nightshift-outcome'),
      outcome,
    );
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result.body).includes(UPSTREAM_KEY), false);
    assert.equal(
      JSON.stringify(result.body).includes('private provider failure'),
      false,
    );
    assertContractHeader(result);
  }
});

test('malformed and oversized provider bodies fail once with a bounded error', async () => {
  for (const response of [
    new Response('{not json', {
      headers: { 'content-type': 'application/json' },
    }),
    new Response('x'.repeat(65_537)),
  ]) {
    let calls = 0;
    const { handler } = fixture({
      fetcher: () => {
        calls++;
        return response;
      },
    });
    const result = await post(handler);
    assert.equal(result.status, 502);
    assert.equal(calls, 1);
    assert.ok(JSON.stringify(result.body).length < 1024);
  }
});

test('oversized requests and already-cancelled requests never dispatch', async () => {
  const { handler, requests } = fixture();
  const tooLarge = request({
    messages: [{ role: 'user', content: 'x'.repeat(131_073) }],
  });
  assert.ok((await post(handler, tooLarge)).status >= 400);
  const controller = new AbortController();
  controller.abort();
  const result = await post(handler, request(), { signal: controller.signal });
  assert.equal(result.status, 499);
  assert.equal(
    new Headers(result.headers).get('x-haze-nightshift-outcome'),
    null,
  );
  assert.equal(requests.length, 0);
});

test('a timed-out provider receives cancellation and is never retried', async () => {
  let calls = 0;
  let upstreamAborted = false;
  const handler = createStrictHandler({
    resolveModel: () => target(),
    timeoutMs: 15,
    fetcher: (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) => {
        const abort = () => {
          upstreamAborted = true;
          reject(init.signal.reason);
        };
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      });
    },
  });
  const result = await post(handler);
  assert.equal(result.status, 504);
  assert.equal(
    new Headers(result.headers).get('x-haze-nightshift-outcome'),
    'unknown',
  );
  assert.equal(calls, 1);
  assert.equal(upstreamAborted, true);
});

test('predispatch validation and policy rejection never claim an unknown remote outcome', async () => {
  const invalidRequest = fixture();
  const badInput = await post(
    invalidRequest.handler,
    request({ max_tokens: 0 }),
  );
  assert.equal(badInput.status, 400);
  assert.equal(
    new Headers(badInput.headers).get('x-haze-nightshift-outcome'),
    null,
  );
  assert.equal(invalidRequest.requests.length, 0);

  const unavailable = fixture({ resolvedTarget: null });
  const denied = await post(unavailable.handler);
  assert.equal(denied.status, 409);
  assert.equal(
    new Headers(denied.headers).get('x-haze-nightshift-outcome'),
    null,
  );
  assert.equal(unavailable.requests.length, 0);
});

test('cancellation while resolving a model remains a known predispatch cancellation', async () => {
  let release;
  let calls = 0;
  const handler = createStrictHandler({
    resolveModel: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    fetcher: () => {
      calls++;
      return Response.json(completion());
    },
  });
  const controller = new AbortController();
  const pending = post(handler, request(), { signal: controller.signal });
  controller.abort();
  release(target());
  const result = await pending;
  assert.equal(result.status, 499);
  assert.equal(calls, 0);
  assert.equal(
    new Headers(result.headers).get('x-haze-nightshift-outcome'),
    null,
  );
});

test('upstream redirects never forward credentials to a different endpoint', async (t) => {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    res.writeHead(302, {
      location: `http://127.0.0.1:${server.address().port}/redirected`,
    });
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const handler = createStrictHandler({
    resolveModel: () =>
      target({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` }),
  });
  const result = await post(handler);
  assert.equal(result.status, 502);
  assert.deepEqual(paths, ['/v1/chat/completions']);
});

function runtime(overrides = {}) {
  return {
    data: {
      setpoints: {
        privacyMin: 'cloud-ok',
        crossCheckThreshold: 'auto',
        withholdPatterns: [],
      },
    },
    findModel: (id) => ({
      id,
      provider: 'nvidia',
      nativeId: id,
      thinkingControl: 'chat_template_kwargs',
      endpointType: 'chat',
    }),
    getKey: () => UPSTREAM_KEY,
    nvidia: {
      BASE_URL: 'https://integrate.api.nvidia.com/v1',
      endpointType: () => 'chat',
    },
    resolveAppPolicy: (app) => ({
      app,
      privacy: 'cloud-ok',
      mode: null,
      premiumBudget: null,
      crossCheck: 'auto',
      lanes: null,
      hasRule: false,
    }),
    resolvePrivacyFloor: () => 'cloud-ok',
    floorAdmits: () => true,
    disabledModelIds: () => new Set(),
    modelAvailability: () => ({ active: true }),
    resolveAppLaneAllow: () => null,
    modelOnAllowedLanes: () => true,
    redact: {
      withholdMatches: () => [],
      redactRequest: (body) => ({ req: body, ctx: { map: new Map() } }),
    },
    ...overrides,
  };
}

function facadeFixture(RT = runtime()) {
  const requests = [];
  const handler = makeHazeStrictFacade({
    RT,
    fetcher: async (url, init) => {
      requests.push({ url: String(url), init, body: JSON.parse(init.body) });
      return Response.json(completion());
    },
  });
  return { handler, requests };
}

test('production facade fixes the app identity and honors the registered NVIDIA target', async () => {
  const apps = [];
  const RT = runtime();
  const resolvePolicy = RT.resolveAppPolicy;
  RT.resolveAppPolicy = (app) => {
    apps.push(app);
    return resolvePolicy(app);
  };
  const { handler, requests } = facadeFixture(RT);
  const result = await post(handler, request(), {
    headers: {
      'meterless-app': 'untrusted-app',
      'x-meterless-app': 'untrusted-app',
      'x-meterless-scope': 'untrusted-scope',
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(apps, ['haze-agent']);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://integrate.api.nvidia.com/v1/chat/completions',
  );
  assert.equal(requests[0].body.model, MODEL);
});

test('production facade refuses missing authority, aliases and unavailable registry targets', async () => {
  const valid = runtime();
  const variants = [
    runtime({ findModel: undefined }),
    runtime({ findModel: () => null }),
    runtime({
      findModel: (id) => ({ ...valid.findModel(id), aliasOf: OTHER_MODEL }),
    }),
    runtime({
      findModel: (id) => ({ ...valid.findModel(id), nativeId: OTHER_MODEL }),
    }),
    runtime({
      findModel: (id) => ({
        ...valid.findModel(id),
        provider: 'openai-compatible',
      }),
    }),
    runtime({ getKey: undefined }),
    runtime({ getKey: () => '' }),
    runtime({ getKey: () => 'invalid\ncredential' }),
    runtime({
      getKey: () => {
        throw new Error(`${UPSTREAM_KEY}: private runtime failure`);
      },
    }),
    runtime({ resolveAppPolicy: undefined }),
    runtime({ resolvePrivacyFloor: undefined }),
    runtime({ floorAdmits: undefined }),
    runtime({ disabledModelIds: undefined }),
    runtime({ disabledModelIds: () => new Set([MODEL]) }),
    runtime({ modelAvailability: undefined }),
    runtime({ modelAvailability: () => ({ active: false }) }),
    runtime({ resolveAppLaneAllow: undefined }),
    runtime({ modelOnAllowedLanes: undefined }),
    runtime({
      nvidia: {
        ...valid.nvidia,
        BASE_URL: 'https://other-provider.example/v1',
      },
    }),
    runtime({ nvidia: { ...valid.nvidia, endpointType: () => 'responses' } }),
  ];
  for (const RT of variants) {
    const { handler, requests } = facadeFixture(RT);
    const result = await post(handler);
    assert.ok(result.status >= 400);
    assert.equal(requests.length, 0);
    assert.equal(JSON.stringify(result.body).includes(UPSTREAM_KEY), false);
  }
});

test('production facade preserves operator policy by refusing incompatible strict calls', async () => {
  const valid = runtime();
  const policy = (overrides) => (app) => ({
    ...valid.resolveAppPolicy(app),
    ...overrides,
  });
  const variants = [
    runtime({ resolveAppPolicy: policy({ mode: 'fast' }) }),
    runtime({ resolveAppPolicy: policy({ premiumBudget: 0 }) }),
    runtime({ resolveAppPolicy: policy({ premiumBudget: 10 }) }),
    runtime({ resolveAppPolicy: policy({ crossCheck: 'always' }) }),
    runtime({ resolvePrivacyFloor: () => 'local-only' }),
    runtime({ resolveAppPolicy: policy({ privacy: 'local-only' }) }),
    runtime({ floorAdmits: () => false }),
    runtime({
      resolveAppLaneAllow: () => new Set(['forbidden-lane']),
      modelOnAllowedLanes: () => false,
    }),
  ];
  for (const RT of variants) {
    const { handler, requests } = facadeFixture(RT);
    const result = await post(handler);
    assert.ok(result.status >= 400);
    assert.equal(requests.length, 0);
  }
});

test('production facade refuses mandatory global quality stages before inference', async () => {
  for (const key of [
    'crossCheckThreshold',
    'qualityRace',
    'generativeVerifier',
    'moaSynthesis',
    'debateRound',
    'reasoningScaffold',
  ]) {
    for (const value of ['always', 'unrecognized-setting']) {
      const RT = runtime();
      RT.data.setpoints[key] = value;
      const { handler, requests } = facadeFixture(RT);
      const result = await post(handler);
      assert.equal(result.status, 409, `${key}=${value}`);
      assert.equal(requests.length, 0);
    }
  }
});

test('production facade refuses withhold matches and redaction that would change the admitted body', async () => {
  const valid = runtime();
  const variants = [
    runtime({ redact: undefined }),
    runtime({
      data: {
        setpoints: { ...valid.data.setpoints, withholdPatterns: null },
      },
    }),
    runtime({
      redact: { ...valid.redact, withholdMatches: () => 'invalid-hook-result' },
    }),
    runtime({
      redact: {
        ...valid.redact,
        withholdMatches: () => ['synthetic-sensitive-pattern'],
      },
    }),
    runtime({
      redact: {
        ...valid.redact,
        redactRequest: (body) => {
          body.messages[0].content = 'redacted in place';
          return { req: body, ctx: { map: new Map() } };
        },
      },
    }),
    runtime({
      redact: {
        ...valid.redact,
        redactRequest: (body) => ({
          req: body,
          ctx: { map: new Map([['private', 'replacement']]) },
        }),
      },
    }),
    runtime({
      redact: {
        ...valid.redact,
        redactRequest: (body) => ({
          req: { ...body, messages: [{ role: 'user', content: 'redacted' }] },
          ctx: { map: new Map() },
        }),
      },
    }),
  ];
  for (const RT of variants) {
    const { handler, requests } = facadeFixture(RT);
    const result = await post(handler);
    assert.ok(result.status >= 400);
    assert.equal(requests.length, 0);
  }
});
