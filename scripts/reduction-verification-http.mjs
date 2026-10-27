import { randomUUID } from 'node:crypto';

/** Retry only reads and the two verified idempotent POST endpoints, with the SAME key/body. */
export function createReductionVerificationReader({
  fetchImpl = fetch,
  onRetry = () => {},
  retryDelayMs = 100,
} = {}) {
  return async (origin, path, body, key = randomUUID()) => {
    const replaySafe =
      body === undefined || ['/api/tasks', '/api/artifacts'].includes(path);
    const options =
      body === undefined
        ? { headers: { Connection: 'close' } }
        : {
            method: 'POST',
            headers: {
              Connection: 'close',
              'Content-Type': 'application/json',
              Origin: origin,
              'Idempotency-Key': key,
            },
            body: JSON.stringify(body),
          };
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      let text;
      try {
        response = await fetchImpl(`${origin}${path}`, options);
        text = await response.text();
      } catch (error) {
        const code = error?.cause?.code ?? error?.code;
        if (
          attempt ||
          !replaySafe ||
          !['ECONNRESET', 'UND_ERR_SOCKET'].includes(code)
        )
          throw new Error(`Verification request failed: ${path}`, {
            cause: error,
          });
        onRetry({ path, attempt: 1, reason: code });
        await new Promise((done) => setTimeout(done, retryDelayMs));
        continue;
      }
      if (!attempt && replaySafe && response.status === 408) {
        onRetry({ path, attempt: 1, reason: 'http_408' });
        await new Promise((done) => setTimeout(done, retryDelayMs));
        continue;
      }
      let result;
      try {
        result = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `Verification response is not JSON: ${path}, HTTP ${response.status}, ${Buffer.byteLength(text)} bytes`,
          { cause: error },
        );
      }
      if (!response.ok)
        throw new Error(`Verification HTTP ${response.status}: ${path}`);
      return result;
    }
    throw new Error(`Verification retry exhausted: ${path}`);
  };
}
