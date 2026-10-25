import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = fileURLToPath(
  new URL('../../', import.meta.url),
);

/** Which configured places HazeOps watches. The fallback place is listed first. */
export type Coverage = 'malaysia' | 'asean' | 'worldwide';

export interface ServerConfig {
  /** Spec §15.3: configured PORT, default 8000. */
  port: number;
  /** Loopback by default: external binding requires authentication (Spec §15.3). */
  host: string;
  stateDir: string;
  coverage: Coverage;
  /** SAMPLE_MODE=true disables every network operation (Spec §17.1 offline_sample). */
  sampleMode: boolean;
  /** Optional shared secret for operator-only endpoints such as /api/heartbeat/tick. */
  operatorToken: string | null;
  schedulerEnabled: boolean;
  keys: {
    openAq: string | null;
    firms: string | null;
    zetarisUsername: string | null;
    zetarisPassword: string | null;
  };
  zetarisBaseUrl: string;
}

function text(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function loadConfig(): ServerConfig {
  const coverage = (text('HAZEOPS_COVERAGE') ?? 'asean') as Coverage;
  if (!['malaysia', 'asean', 'worldwide'].includes(coverage)) {
    throw new Error(
      `HAZEOPS_COVERAGE must be malaysia, asean or worldwide (got "${coverage}")`,
    );
  }
  return {
    port: Number(text('PORT') ?? 8000),
    host: text('HOST') ?? '127.0.0.1',
    stateDir: resolve(REPOSITORY_ROOT, text('HAZE_STATE_DIR') ?? '.state/haze'),
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
  };
}
