import { boundedFetch, type FetchedBytes } from './http.js';

export interface ZetarisSession {
  idToken?: string;
  orgId?: number;
}

export function zetarisQueryUrl(baseUrl: string): string {
  return `${baseUrl}/api/proxy/query/sql/start`;
}

export async function loginZetaris(
  options: { baseUrl: string; username: string; password: string },
  signal: AbortSignal,
): Promise<ZetarisSession> {
  const response = await boundedFetch(`${options.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: options.username,
      password: options.password,
    }),
    signal,
    label: 'Zetaris login',
  });
  return JSON.parse(response.raw.toString('utf8')) as ZetarisSession;
}

export function queryZetaris(
  options: {
    baseUrl: string;
    token: string;
    orgId: number;
    sql: string;
    label: string;
  },
  signal: AbortSignal,
): Promise<FetchedBytes> {
  return boundedFetch(zetarisQueryUrl(options.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.token}`,
      'X-Org-ID': String(options.orgId),
      'X-Request-ID': crypto.randomUUID(),
    },
    body: JSON.stringify({ select: options.sql, pageLimit: 1000 }),
    signal,
    label: options.label,
  });
}
