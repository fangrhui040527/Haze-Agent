import { fileURLToPath } from 'node:url';
import {
  loadPinnedQueries,
  type PinnedQuery,
} from '../capabilities/evidence-collection/sources/zetaris.js';
import pinnedQueries from './config/zetaris-queries.json' with { type: 'json' };

export type Coverage = 'malaysia' | 'asean' | 'worldwide';

export interface DashboardConfig {
  coverage: Coverage;
  sampleMode: boolean;
  operatorToken: string | null;
  schedulerEnabled: boolean;
  keys: {
    openAq: string | null;
    firms: string | null;
    zetarisUsername: string | null;
    zetarisPassword: string | null;
  };
  zetarisBaseUrl: string;
  zetarisQueries: readonly PinnedQuery[];
}

/** Host configuration only; browser requests cannot select credentials or SQL. */
export function loadDashboardConfig(
  env: NodeJS.ProcessEnv = {},
): DashboardConfig {
  const text = (name: string): string | null => env[name]?.trim() || null;
  const coverage = text('HAZEOPS_COVERAGE') ?? 'asean';
  if (
    coverage !== 'malaysia' &&
    coverage !== 'asean' &&
    coverage !== 'worldwide'
  )
    throw new Error(
      `HAZEOPS_COVERAGE must be malaysia, asean or worldwide (got "${coverage}")`,
    );
  const queryFile = text('HAZEOPS_ZETARIS_QUERIES_FILE');
  return {
    coverage,
    sampleMode: text('SAMPLE_MODE') === 'true',
    operatorToken: text('HAZE_OPERATOR_TOKEN'),
    schedulerEnabled: text('HAZEOPS_SCHEDULER') !== 'off',
    keys: {
      openAq: text('OPEN_AQ_KEY'),
      firms: text('FIRMS_MAP_KEY'),
      zetarisUsername: text('ZETARIS_USERNAME'),
      zetarisPassword: text('ZETARIS_PASSWORD'),
    },
    zetarisBaseUrl: text('ZETARIS_BASE_URL') ?? 'http://localhost:3000',
    zetarisQueries: queryFile
      ? loadPinnedQueries(queryFile)
      : pinnedQueries.queries,
  };
}

export const DASHBOARD_CONFIG_DIRECTORY = fileURLToPath(
  new URL('./config/', import.meta.url),
);
