/**
 * A deliberately narrow Nightshift transport for Haze's admitted model calls.
 * This module never enters Nightshift's routing/retry/tool orchestration path.
 * The production resolver owns registry, credential and operator-policy checks.
 */
export const STRICT_CONTRACT = Object.freeze({
  id: 'nightshift-haze-strict-v1',
  version: 1,
  model_authority: 'exact',
  output_cap: 'provider-enforced',
  finish_reason: 'upstream',
  usage: 'upstream-or-null',
  reasoning: 'nemotron-enable-thinking',
  structured_output: 'json-object-or-schema',
  single_call: true,
});

const MAX_REQUEST_BYTES = 131_072;
const MAX_OUTPUT_TOKENS = 16_384;
const ROOT = '/v1/haze';
const ALLOWED_KEYS = new Set([
  'model',
  'messages',
  'max_tokens',
  'max_completion_tokens',
  'stream',
  'response_format',
  'temperature',
  'chat_template_kwargs',
]);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reply(status, body) {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-haze-nightshift-contract': STRICT_CONTRACT.id,
    },
    body,
  };
}

function failure(status, code) {
  return reply(status, {
    error: {
      type: 'haze_strict_contract_error',
      code,
      message:
        'Nightshift strict inference could not satisfy the admitted request.',
    },
  });
}

function validModel(model) {
  return (
    typeof model === 'string' &&
    model.length > 0 &&
    model.length <= 256 &&
    model === model.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(model)
  );
}

function targetUrl(target, model) {
  if (
    !target ||
    target.id !== model ||
    target.provider !== 'nvidia' ||
    target.tokenField !== 'max_tokens' ||
    target.supportsReasoning !== true ||
    !/nemotron/iu.test(model) ||
    typeof target.apiKey !== 'string' ||
    !target.apiKey.trim() ||
    target.apiKey.length > 16_384 ||
    /[\r\n]/u.test(target.apiKey)
  )
    return null;
  try {
    const url = new URL(target.baseUrl);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !loopback) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/chat/completions`;
    return url;
  } catch {
    return null;
  }
}

function requestBody(body) {
  if (!record(body) || !validModel(body.model)) return null;
  if (Object.keys(body).some((key) => !ALLOWED_KEYS.has(key))) return null;
  if (body.stream !== undefined && body.stream !== false) return null;
  if (
    body.max_tokens !== undefined &&
    body.max_completion_tokens !== undefined &&
    body.max_tokens !== body.max_completion_tokens
  )
    return null;
  const cap = body.max_tokens ?? body.max_completion_tokens;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_OUTPUT_TOKENS)
    return null;
  if (
    !Array.isArray(body.messages) ||
    body.messages.length < 1 ||
    body.messages.length > 32 ||
    body.messages.some(
      (message) =>
        !record(message) ||
        Object.keys(message).some(
          (key) => !['role', 'content'].includes(key),
        ) ||
        !['system', 'user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' ||
        !message.content.trim(),
    )
  )
    return null;
  if (
    !record(body.chat_template_kwargs) ||
    Object.keys(body.chat_template_kwargs).length !== 1 ||
    body.chat_template_kwargs.enable_thinking !== false
  )
    return null;
  if (
    body.temperature !== undefined &&
    (typeof body.temperature !== 'number' ||
      !Number.isFinite(body.temperature) ||
      body.temperature < 0 ||
      body.temperature > 2)
  )
    return null;
  if (body.response_format !== undefined) {
    const format = body.response_format;
    if (!record(format)) return null;
    if (format.type === 'json_object') {
      if (Object.keys(format).length !== 1) return null;
    } else if (format.type === 'json_schema') {
      if (
        Object.keys(format).some(
          (key) => !['type', 'json_schema'].includes(key),
        ) ||
        !record(format.json_schema) ||
        Object.keys(format.json_schema).some(
          (key) => !['name', 'strict', 'schema'].includes(key),
        ) ||
        typeof format.json_schema.name !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/u.test(format.json_schema.name) ||
        format.json_schema.strict !== true ||
        !record(format.json_schema.schema)
      )
        return null;
    } else return null;
  }
  // Construct the provider request explicitly: no routing hints or server tools.
  const outgoing = {
    model: body.model,
    messages: body.messages,
    max_tokens: cap,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
    ...(body.temperature !== undefined
      ? { temperature: body.temperature }
      : {}),
    ...(body.response_format !== undefined
      ? { response_format: body.response_format }
      : {}),
  };
  try {
    const serialized = JSON.stringify(outgoing);
    return Buffer.byteLength(serialized, 'utf8') <= MAX_REQUEST_BYTES
      ? serialized
      : null;
  } catch {
    return null;
  }
}

export function createStrictHandler({
  resolveModel,
  fetcher = fetch,
  timeoutMs = 120_000,
  maxResponseBytes = 65_536,
}) {
  if (typeof resolveModel !== 'function')
    throw new Error('A model resolver is required.');
  return async ({ method, path, model, body, signal, headers = {} }) => {
    const inspect = method === 'GET' && path === `${ROOT}/contract`;
    const generate = method === 'POST' && path === `${ROOT}/chat/completions`;
    if (!inspect && !generate) return failure(404, 'strict_route_not_found');
    if (signal?.aborted) return failure(499, 'strict_request_cancelled');
    let serialized;
    if (generate) {
      serialized = requestBody(body);
      if (serialized === null) return failure(400, 'strict_request_invalid');
      model = body.model;
    } else if (!validModel(model)) return failure(400, 'strict_model_required');

    let target;
    try {
      target = await resolveModel(model, headers, generate ? body : undefined);
    } catch {
      return failure(409, 'strict_model_policy_unavailable');
    }
    const url = targetUrl(target, model);
    if (!url) return failure(409, 'strict_model_unavailable');
    if (signal?.aborted) return failure(499, 'strict_request_cancelled');
    if (inspect) return reply(200, { ...STRICT_CONTRACT, models: [model] });

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, deadline.signal])
      : deadline.signal;
    let reader;
    let response;
    let dispatchStarted = false;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Strict inference interrupted.'));
      if (requestSignal.aborted) onAbort();
      else requestSignal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const dispatch = async () => {
        requestSignal.throwIfAborted();
        dispatchStarted = true;
        response = await fetcher(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${target.apiKey}`,
          },
          body: serialized,
          signal: requestSignal,
          redirect: 'error',
        });
        if (!response.ok)
          return failure(response.status, 'strict_upstream_rejected');
        if (!response.body)
          return failure(502, 'strict_upstream_response_invalid');
        reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          requestSignal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxResponseBytes)
            return failure(502, 'strict_upstream_response_oversized');
          chunks.push(chunk.value);
        }
        let result;
        try {
          result = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        } catch {
          return failure(502, 'strict_upstream_response_invalid');
        }
        if (!record(result))
          return failure(502, 'strict_upstream_response_invalid');
        // Never manufacture model, id, finish_reason or missing token usage.
        // Haze validates those fields and the action before accepting output.
        return reply(response.status, result);
      };
      return await Promise.race([dispatch(), aborted]);
    } catch {
      const result = failure(
        signal?.aborted ? 499 : deadline.signal.aborted ? 504 : 502,
        signal?.aborted
          ? 'strict_request_cancelled'
          : deadline.signal.aborted
            ? 'strict_upstream_timeout'
            : 'strict_upstream_unavailable',
      );
      // The local gateway answered, but no upstream completion established the
      // remote outcome. Haze must keep the call charged and must not replay it.
      if (dispatchStarted)
        result.headers['x-haze-nightshift-outcome'] = 'unknown';
      return result;
    } finally {
      clearTimeout(timer);
      requestSignal.removeEventListener('abort', onAbort);
      deadline.abort();
      if (reader) {
        void reader.cancel().catch(() => undefined);
      } else {
        void response?.body?.cancel().catch(() => undefined);
      }
    }
  };
}
