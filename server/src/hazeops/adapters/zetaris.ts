import { existsSync, readFileSync } from 'node:fs';
import type { Location } from '../../../../frontend/src/shared/types/domain.ts';
import {
  decisionTimeCheck,
  resolutionCheck,
  unitCheck,
  valuesCheck,
} from '../checks.ts';
import { bundleRaw, pinEvidence } from '../evidence.ts';
import { boundedFetch, sha256 } from '../http.ts';
import type {
  AdapterContext,
  AdapterResult,
  EvidenceSourceKind,
  FactDraft,
  PinnedEvidence,
  SourceAdapter,
  WatcherSpec,
} from '../types.ts';

/**
 * Zetaris: the spec's intended path for "approved pinned evidence queries" (Spec §2,
 * §12). Talks to the local Zetaris platform's REST gateway (the same calls its own
 * verify.sh uses): POST /api/auth/login, then POST /api/proxy/query/sql/start.
 *
 * Queries are pinned: each has an id, a version and exact SQL, and the SQL text is
 * hashed into the evidence record. No queries are configured until the haze views
 * exist in Zetaris; until then the watcher only confirms the login works.
 */

export const ZETARIS_SOURCE_ID = 'src-zetaris';

export interface PinnedQuery {
  id: string;
  version: number;
  description: string;
  sql: string;
  sourceKind: EvidenceSourceKind;
  /** Column names in the result rows. */
  columns: { locationId: string; observedAt: string; pm25: string };
  unit: string;
}

export function loadPinnedQueries(path: string): PinnedQuery[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    queries?: PinnedQuery[];
  };
  return parsed.queries ?? [];
}

export function zetarisSpec(queries: readonly PinnedQuery[]): WatcherSpec {
  return {
    id: 'zetaris-pinned-queries',
    source: {
      id: ZETARIS_SOURCE_ID,
      name: 'Zetaris (pinned queries)',
      kind: 'data_platform',
      evidenceKind: 'report',
      organisation: 'Local Zetaris platform',
      cadence: 'Every 15 min',
      licenceNote: 'Each registered data source keeps its own licence.',
      reliabilityNote:
        'Only as reliable as the data sources registered in Zetaris.',
      url: 'https://zetaris.github.io/getting-started/',
    },
    requiresEnv: ['ZETARIS_USERNAME', 'ZETARIS_PASSWORD'],
    query: queries.length
      ? queries.map((q) => `${q.id}@v${q.version}`).join(', ')
      : 'login check only (no pinned queries configured)',
    placeSelector: 'as defined by each pinned query',
    timeSelector: 'as defined by each pinned query',
    cadenceSec: 15 * 60,
    rateLimit:
      'local platform; one login plus one request per pinned query per run',
    freshnessMinutes: 3 * 60,
  };
}

interface LoginResponse {
  idToken?: string;
  orgId?: number;
}

/** Find the row array in a query response without assuming one exact envelope. */
function extractRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.filter(
      (r): r is Record<string, unknown> => !!r && typeof r === 'object',
    );
  }
  if (body && typeof body === 'object') {
    for (const key of ['rows', 'data', 'records', 'result', 'results']) {
      const rows = extractRows((body as Record<string, unknown>)[key]);
      if (rows.length) return rows;
    }
  }
  return [];
}

export function zetarisAdapter(
  locations: readonly Location[],
  options: {
    baseUrl: string;
    username: string;
    password: string;
    queries: PinnedQuery[];
  },
): SourceAdapter {
  const spec = zetarisSpec(options.queries);
  const known = new Set(locations.map((l) => l.id));

  return {
    spec,
    async run(context: AdapterContext): Promise<AdapterResult> {
      const login = await boundedFetch(`${options.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: options.username,
          password: options.password,
        }),
        signal: context.signal,
        label: 'Zetaris login',
      });
      const session = JSON.parse(login.raw.toString('utf8')) as LoginResponse;
      if (!session.idToken || session.orgId === undefined) {
        throw new Error('Zetaris login returned no token or organisation id');
      }

      if (options.queries.length === 0) {
        return {
          evidence: [],
          stations: [],
          facts: [],
          coverage: {
            requested: 0,
            covered: 0,
            excluded: [],
            gaps: [
              'Login works. No pinned haze queries are configured in server/config/zetaris-queries.json yet.',
            ],
          },
        };
      }

      const evidence: PinnedEvidence[] = [];
      const facts: FactDraft[] = [];
      const excluded: { id: string; reason: string }[] = [];
      for (const query of options.queries) {
        const fetched = await boundedFetch(
          `${options.baseUrl}/api/proxy/query/sql/start`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.idToken}`,
              'X-Org-ID': String(session.orgId),
              'X-Request-ID': crypto.randomUUID(),
            },
            body: JSON.stringify({ select: query.sql, pageLimit: 1000 }),
            signal: context.signal,
            label: `Zetaris query ${query.id}@v${query.version}`,
          },
        );
        const rows = extractRows(JSON.parse(fetched.raw.toString('utf8')));
        const values = rows.map((r) => {
          const raw = r[query.columns.pm25];
          // Missing values and nonnumeric JSON types must never become zero.
          if (
            typeof raw !== 'number' &&
            (typeof raw !== 'string' || raw.trim() === '')
          )
            return null;
          const v = Number(raw);
          return Number.isFinite(v) ? v : null;
        });
        const pinned = pinEvidence({
          raw: bundleRaw([
            {
              label: `sql ${sha256(query.sql).slice(0, 12)}`,
              status: 0,
              sha256: sha256(query.sql),
              body: query.sql,
            },
            {
              label: 'result',
              status: fetched.status,
              sha256: fetched.sha256,
              body: JSON.parse(fetched.raw.toString('utf8')),
            },
          ]),
          upstream: { system: 'zetaris', id: `${query.id}@v${query.version}` },
          sourceId: ZETARIS_SOURCE_ID,
          sourceKind: query.sourceKind,
          title: query.description,
          sourceOwner: 'Zetaris data fabric',
          locator: {
            kind: 'data',
            url: `${options.baseUrl}/api/proxy/query/sql/start`,
            selection: query.sql,
          },
          pollutant: 'pm25',
          unit: query.unit === 'µg/m³' ? 'µg/m³' : null,
          issuedAt: null,
          issuedAtReason:
            'Defined by the upstream source registered in Zetaris.',
          validInterval: null,
          retrievedAt: fetched.retrievedAt,
          nativeTemporalResolution: 'As registered in Zetaris',
          spatialSupport: 'As registered in Zetaris',
          licenceRef: spec.source.licenceNote,
          permittedUses: ['information_display'],
          limitations: [
            'Depends on the source registered behind this Zetaris query.',
          ],
          coverageChecks: [
            unitCheck(query.unit),
            valuesCheck(values),
            resolutionCheck('As registered in Zetaris', false),
            decisionTimeCheck(null, fetched.retrievedAt),
          ],
        });
        evidence.push(pinned);
        rows.forEach((row, i) => {
          const locationId =
            typeof row[query.columns.locationId] === 'string'
              ? (row[query.columns.locationId] as string)
              : '';
          const observedAt =
            typeof row[query.columns.observedAt] === 'string'
              ? (row[query.columns.observedAt] as string)
              : '';
          if (!known.has(locationId) || !observedAt) {
            excluded.push({
              id: `${query.id}#${i}`,
              reason: `unknown location "${locationId}" or missing time`,
            });
            return;
          }
          facts.push({
            about: { type: 'location', id: locationId },
            predicate: `pm25_zetaris_${query.id}`,
            value: {
              value: values[i] ?? null,
              unit: 'µg/m³',
              observedAt,
              query: `${query.id}@v${query.version}`,
            },
            observedAt: new Date(observedAt).toISOString(),
            evidenceId: pinned.record.evidenceId,
          });
        });
      }
      return {
        evidence,
        stations: [],
        facts,
        coverage: {
          requested: facts.length + excluded.length,
          covered: facts.length,
          excluded,
          gaps: [],
        },
      };
    },
  };
}
