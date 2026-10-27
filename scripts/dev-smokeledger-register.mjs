import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const SMOKELEDGER_DATASOURCE = 'sl_pg';
const READY_TIMEOUT_MS = 30 * 60_000;
const RETRY_MS = 5000;

// Zetaris runs in the same compose project, so its containers reach the evidence store
// by service name. Matches the smokeledger-db service in compose.yaml.
const CREATE_SQL = `CREATE DATASOURCE ${SMOKELEDGER_DATASOURCE} DESCRIBE BY "SmokeLedger haze evidence store" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://smokeledger-db:5432/smokeledger",
  username "smokeledger",
  password "smokeledger",
  fetchsize "1000"
)`;

function readOptional(filename) {
  try {
    return readFileSync(filename, 'utf8');
  } catch {
    return '';
  }
}

/** Zetaris settings from the adapter .env.local, then root .env, then the environment. */
export function zetarisSettings(root, env = process.env) {
  return {
    ...parseEnv(
      readOptional(join(root, 'app', 'adapters', 'zetaris', '.env.local')),
    ),
    ...parseEnv(readOptional(join(root, '.env'))),
    ...Object.fromEntries(
      Object.entries(env).filter(([key]) => key.startsWith('ZETARIS_')),
    ),
  };
}

class RetryableError extends Error {}

/**
 * Register the SmokeLedger Postgres as the Zetaris sl_pg datasource and import its
 * tables. Waits for Zetaris to accept a login, since its first boot takes minutes.
 * Safe to repeat: an existing datasource is kept and its tables are re-registered,
 * which picks up tables added since. Resolves to a short status line.
 */
export async function registerSmokeLedgerDatasource({
  root,
  signal,
  env = process.env,
  timeout = READY_TIMEOUT_MS,
  retryMs = RETRY_MS,
}) {
  const settings = zetarisSettings(root, env);
  const base = (settings.ZETARIS_BASE_URL || 'http://localhost:3000').replace(
    /\/$/,
    '',
  );
  const rest = (
    settings.ZETARIS_REST_URL || 'http://localhost:8888/api/v1.0'
  ).replace(/\/$/, '');
  const org = settings.ZETARIS_ORG_ID || '1';
  const canLogin = Boolean(
    settings.ZETARIS_USERNAME && settings.ZETARIS_PASSWORD,
  );
  if (!canLogin && !settings.ZETARIS_API_KEY)
    throw new Error(
      'Set ZETARIS_USERNAME and ZETARIS_PASSWORD (or ZETARIS_API_KEY) in .env',
    );

  async function call(url, init) {
    let response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([AbortSignal.timeout(120_000), signal]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new RetryableError(`Cannot reach ${new URL(url).origin}`);
    }
    // Zetaris answers 502/503 while the API waits on the driver.
    if (response.status >= 500)
      throw new RetryableError(`Zetaris answered HTTP ${response.status}`);
    return response;
  }

  async function token() {
    // A stored key lapses after about an hour, so a fresh login is preferred.
    if (!canLogin) return settings.ZETARIS_API_KEY;
    const response = await call(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: settings.ZETARIS_USERNAME,
        password: settings.ZETARIS_PASSWORD,
      }),
    });
    // The body is not echoed: a rejected login can quote back the password.
    if (!response.ok)
      throw new Error(`Zetaris login failed: HTTP ${response.status}`);
    const body = await response.json();
    const value = body?.idToken ?? body?.token ?? body?.accessToken;
    if (typeof value !== 'string' || !value)
      throw new Error('Zetaris login returned no access token');
    return value;
  }

  async function connect() {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        const bearer = await token();
        return async (sql) => {
          const response = await call(`${rest}/sql-editor/sqls/run`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${bearer}`,
              'X-Org-ID': org,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              queryId: crypto.randomUUID(),
              sql,
              source: 'SqlEditor',
              limit: 1000,
            }),
          });
          if (!response.ok)
            throw new Error(
              `${sql.split(/\s+/).slice(0, 3).join(' ')} failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
            );
          return response.json();
        };
      } catch (error) {
        if (!(error instanceof RetryableError) || Date.now() >= deadline)
          throw error;
        await new Promise((done) => setTimeout(done, retryMs).unref());
        signal.throwIfAborted();
      }
    }
  }

  const run = await connect();
  const listed = await run('SHOW DATASOURCES');
  const exists = (listed?.data ?? []).some(
    (row) => String(row?.[0]).toLowerCase() === SMOKELEDGER_DATASOURCE,
  );
  if (!exists) await run(CREATE_SQL);
  await run(`REGISTER DATASOURCE TABLES FROM ${SMOKELEDGER_DATASOURCE}`);
  return `Zetaris ${SMOKELEDGER_DATASOURCE} ${exists ? 'tables refreshed' : 'registered'}`;
}
