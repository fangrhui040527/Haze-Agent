import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { registerSmokeLedgerDatasource } = (await import(
  new URL('../../scripts/dev-smokeledger-register.mjs', import.meta.url).href
)) as {
  registerSmokeLedgerDatasource: (options: {
    root: string;
    signal: AbortSignal;
    env?: Record<string, string>;
    timeout?: number;
    retryMs?: number;
  }) => Promise<string>;
};

let server: Server | undefined;
afterEach(() => server?.close());

// A stand-in Zetaris: answers 503 for the first logins, then runs SQL by first keyword.
async function fakeZetaris(options: {
  existing: string[];
  unavailable?: number;
}) {
  const sql: string[] = [];
  let logins = 0;
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.url === '/api/auth/login') {
        logins += 1;
        if (logins <= (options.unavailable ?? 0)) return send(503, {});
        return send(200, { idToken: 'token' });
      }
      expect(request.headers.authorization).toBe('Bearer token');
      const { sql: statement } = JSON.parse(body) as { sql: string };
      sql.push(statement);
      if (statement === 'SHOW DATASOURCES')
        return send(200, {
          data: options.existing.map((name) => [name, '', 1]),
        });
      return send(200, { data: [] });
    });
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;
  return {
    sql,
    env: {
      ZETARIS_BASE_URL: origin,
      ZETARIS_REST_URL: `${origin}/api/v1.0`,
      ZETARIS_USERNAME: 'admin',
      ZETARIS_PASSWORD: 'secret',
    },
  };
}

// An empty root, so the developer's own .env never reaches the test.
const root = () => mkdtempSync(join(tmpdir(), 'haze-register-'));

describe('SmokeLedger Zetaris registration', () => {
  it('waits for Zetaris, then creates sl_pg and registers its tables', async () => {
    const zetaris = await fakeZetaris({ existing: [], unavailable: 2 });
    const result = await registerSmokeLedgerDatasource({
      root: root(),
      signal: new AbortController().signal,
      env: zetaris.env,
      retryMs: 10,
    });
    expect(result).toBe('Zetaris sl_pg registered');
    expect(zetaris.sql[0]).toBe('SHOW DATASOURCES');
    expect(zetaris.sql[1]).toContain('CREATE DATASOURCE sl_pg');
    expect(zetaris.sql[1]).toContain(
      'jdbc:postgresql://smokeledger-db:5432/smokeledger',
    );
    expect(zetaris.sql[2]).toBe('REGISTER DATASOURCE TABLES FROM sl_pg');
  });

  it('keeps an existing datasource and only refreshes its tables', async () => {
    const zetaris = await fakeZetaris({ existing: ['SL_PG'] });
    const result = await registerSmokeLedgerDatasource({
      root: root(),
      signal: new AbortController().signal,
      env: zetaris.env,
    });
    expect(result).toBe('Zetaris sl_pg tables refreshed');
    expect(zetaris.sql).toEqual([
      'SHOW DATASOURCES',
      'REGISTER DATASOURCE TABLES FROM sl_pg',
    ]);
  });

  it('reports missing credentials without contacting Zetaris', async () => {
    await expect(
      registerSmokeLedgerDatasource({
        root: root(),
        signal: new AbortController().signal,
        env: {},
      }),
    ).rejects.toThrow(/ZETARIS_USERNAME/);
  });
});
