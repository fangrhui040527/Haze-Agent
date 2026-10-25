export class ZetarisTransportError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'provider_failure' | 'invalid_evidence',
    readonly outcome: 'failed' | 'unknown' = 'failed',
  ) {
    super(message);
  }
}
function fail(
  message: string,
  code: ZetarisTransportError['code'] = 'unavailable',
  outcome: ZetarisTransportError['outcome'] = 'failed',
): never {
  throw new ZetarisTransportError(message, code, outcome);
}

/** Authenticated, bounded transport only. SQL construction belongs to a capability. */
export async function executeZetarisQuery(
  env: NodeJS.ProcessEnv,
  request: { query: string; requestId: string; rowLimit: number },
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  signal.throwIfAborted();
  const sample = env['SAMPLE_MODE']?.trim().toLowerCase();
  if (sample && sample !== '0' && sample !== 'false')
    fail(
      'SAMPLE_MODE disables live evidence retrieval; no sample substitution was performed.',
    );
  const key = env['ZETARIS_API_KEY']?.trim();
  if (!key)
    fail(
      'The Zetaris adapter is unavailable: ZETARIS_API_KEY is missing. No other source was queried.',
    );
  let url: URL;
  try {
    url = new URL(env['ZETARIS_REST_URL'] ?? 'http://localhost:8888/api/v1.0');
  } catch {
    fail('ZETARIS_REST_URL must be an HTTP(S) API base URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port === '8889'
  )
    fail(
      'ZETARIS_REST_URL must use HTTP(S) without credentials, query, fragment, or port 8889.',
    );
  const organization = env['ZETARIS_ORG_ID'] ?? '1';
  if (!/^\d+$/u.test(organization))
    fail('ZETARIS_ORG_ID must be a numeric organization ID.');
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/sql-editor/sqls/run`;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  try {
    const response = await fetcher(url, {
      method: 'POST',
      redirect: 'error',
      signal: bounded,
      headers: {
        Authorization: `Bearer ${key}`,
        'X-Org-ID': organization,
        'X-Request-ID': request.requestId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        queryId: request.requestId,
        sql: request.query,
        source: 'SqlEditor',
        limit: request.rowLimit,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      fail(
        `Zetaris evidence retrieval failed (HTTP ${response.status}); no alternate source was queried.`,
        'provider_failure',
      );
    }
    if (!response.body)
      fail('Zetaris returned an empty response.', 'invalid_evidence');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    bounded.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        bounded.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array))
          fail(
            'Zetaris returned an invalid response body.',
            'invalid_evidence',
          );
        bytes += value.byteLength;
        if (bytes > 524_288) {
          await reader.cancel();
          fail(
            'Zetaris evidence exceeded the response byte limit.',
            'invalid_evidence',
          );
        }
        chunks.push(value);
      }
      bounded.throwIfAborted();
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      if (raw.includes(key))
        fail(
          'Zetaris evidence echoed a server credential and cannot be persisted.',
          'invalid_evidence',
        );
      return raw;
    } finally {
      bounded.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ZetarisTransportError) throw error;
    // Network errors can contain credentials; expose only this fixed transport message.
    fail(
      'Zetaris evidence retrieval failed or timed out; no alternate source was queried.',
      'provider_failure',
      'unknown',
    );
  }
}
