export class SmokeLedgerError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'provider_failure' | 'invalid_evidence',
    readonly outcome: 'failed' | 'unknown' = 'failed',
  ) {
    super(message);
  }
}

const MAX_RESPONSE_BYTES = 2_097_152;
const DEFAULT_URL = 'http://127.0.0.1:8100';

export interface SmokeLedgerResponse {
  status: number;
  body: unknown;
}

/** Bounded loopback transport to the SmokeLedger sidecar; no fallback source is ever tried. */
export function createSmokeLedgerClient(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
) {
  let base: URL;
  try {
    base = new URL(env['SMOKELEDGER_URL']?.trim() || DEFAULT_URL);
  } catch {
    throw new SmokeLedgerError(
      'SMOKELEDGER_URL must be an HTTP(S) base URL.',
      'unavailable',
    );
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new SmokeLedgerError(
      'SMOKELEDGER_URL must use HTTP(S) without credentials, query or fragment.',
      'unavailable',
    );

  async function request(
    method: 'GET' | 'POST',
    path: string,
    signal: AbortSignal,
    options: { body?: unknown; timeoutMs: number; mayHaveExecuted: boolean },
  ): Promise<SmokeLedgerResponse> {
    signal.throwIfAborted();
    const url = new URL(path, base);
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(options.timeoutMs),
    ]);
    try {
      const response = await fetcher(url, {
        method,
        redirect: 'error',
        signal: bounded,
        headers: { 'Content-Type': 'application/json' },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES)
        throw new SmokeLedgerError(
          'SmokeLedger response exceeded the byte limit.',
          'invalid_evidence',
        );
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new SmokeLedgerError(
          'SmokeLedger returned a non-JSON response.',
          'invalid_evidence',
        );
      }
      return { status: response.status, body };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SmokeLedgerError) throw error;
      // A dispatched run may have executed; read-only checks have no effect to reconcile.
      throw new SmokeLedgerError(
        `SmokeLedger sidecar at ${base.origin} did not respond; no alternate source was queried.`,
        'unavailable',
        options.mayHaveExecuted ? 'unknown' : 'failed',
      );
    }
  }

  return {
    origin: base.origin,
    health: (signal: AbortSignal) =>
      request('GET', '/health', signal, {
        timeoutMs: 10_000,
        mayHaveExecuted: false,
      }),
    // One SmokeLedger computation per call; the caller's agents orchestrate, not the sidecar.
    method: (
      name: 'outlook' | 'trace' | 'critic' | 'previews',
      body: unknown,
      signal: AbortSignal,
    ) =>
      request('POST', `/api/methods/${name}`, signal, {
        body,
        timeoutMs: name === 'previews' ? 30_000 : 300_000,
        // Outlook and trace write their runs and evidence, so an unanswered call may have run.
        mayHaveExecuted: name === 'outlook' || name === 'trace',
      }),
    verify: (evidenceId: string, signal: AbortSignal) =>
      request(
        'GET',
        `/api/evidence/${encodeURIComponent(evidenceId)}/verify`,
        signal,
        { timeoutMs: 60_000, mayHaveExecuted: false },
      ),
    claimCheck: (body: unknown, signal: AbortSignal) =>
      request('POST', '/api/claims/check', signal, {
        body,
        timeoutMs: 120_000,
        mayHaveExecuted: false,
      }),
  };
}
export type SmokeLedgerClient = ReturnType<typeof createSmokeLedgerClient>;
