import type {
  AssignmentDefinition,
  CapabilityDefinition,
  ExecutionMode,
  ToolDefinition,
} from '../../orchestration/ports.js';
import { firmsAdapter } from './sources/firms.js';
import { openAqAdapter } from './sources/openAq.js';
import { openMeteoAdapter } from './sources/openMeteo.js';
import { zetarisAdapter, type PinnedQuery } from './sources/zetaris.js';
import { collectOnce } from './collection.js';
import {
  collectionCaptureSchema,
  evidenceCollectionScopeSchema,
  type CollectionCapture,
  type EvidenceCollectionScope,
} from './contracts.js';
import { createFixtureCollectionAdapter } from './fixtures.js';
import type { SourceAdapter } from './types.js';

export const EVIDENCE_COLLECTION_TOOL_ID = 'haze-evidence-collect';

export class CollectionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollectionUnavailableError';
  }
}

export function createEvidenceCollectionCapability(): CapabilityDefinition {
  return {
    card: {
      id: 'evidence-collection',
      version: 'evidence-collection.v1',
      purpose:
        'Collect one explicitly selected haze source for bounded supplied locations, retaining exact raw evidence and coverage.',
      work_products: ['evidence.collection.capture', 'evidence.gap'],
      required_tools: [EVIDENCE_COLLECTION_TOOL_ID],
      roles: ['HazeOps'],
      readiness: 'implemented',
      limitations: [
        'Collects each provider’s current documented window; arbitrary historical dates are unsupported.',
        'Collected evidence remains unreviewed and is not automatically accepted into either World Model.',
        'Live readiness requires a captured configured source execution.',
        'Optional web search returns third-party documents, not measurements: no unit, resolution or station checks apply, provider ranking is not reproducible, and the retained snippets are never accepted into either World Model.',
      ],
    },
    matches: (request) =>
      typeof request.scope === 'object' &&
      request.scope !== null &&
      !Array.isArray(request.scope) &&
      request.scope.capability === 'evidence-collection',
    assignments: (request) => [
      {
        key: 'collection',
        definition_id: 'evidence-collection.collect',
        brief: request.objective,
        depends_on: [],
        input: request.scope,
      },
    ],
  };
}

export interface EvidenceCollectionToolOptions {
  mode?: ExecutionMode;
  env?: NodeJS.ProcessEnv;
  /** Trusted host injection for tests/replay; never supplied by the task request. */
  resolveSource?: (
    scope: EvidenceCollectionScope,
  ) => SourceAdapter | Promise<SourceAdapter>;
  /** Approved, pinned SQL supplied by the host; task input cannot supply SQL. */
  zetarisQueries?: readonly PinnedQuery[];
  evidenceOrigin?: CollectionCapture['evidence_origin'];
}

function liveSource(
  scope: EvidenceCollectionScope,
  options: EvidenceCollectionToolOptions,
): SourceAdapter {
  const env = options.env ?? {};
  if (env.SAMPLE_MODE === 'true')
    throw new CollectionUnavailableError(
      'SAMPLE_MODE=true disables live evidence collection.',
    );
  switch (scope.provider) {
    case 'open-meteo':
      return openMeteoAdapter(scope.locations);
    case 'openaq': {
      if (!env.OPEN_AQ_KEY)
        throw new CollectionUnavailableError('OPEN_AQ_KEY is not set.');
      return openAqAdapter(scope.locations, env.OPEN_AQ_KEY);
    }
    case 'firms': {
      if (!env.FIRMS_MAP_KEY)
        throw new CollectionUnavailableError('FIRMS_MAP_KEY is not set.');
      return firmsAdapter(scope.locations, env.FIRMS_MAP_KEY);
    }
    case 'zetaris': {
      if (!env.ZETARIS_USERNAME || !env.ZETARIS_PASSWORD)
        throw new CollectionUnavailableError(
          'ZETARIS_USERNAME / ZETARIS_PASSWORD are not set.',
        );
      if (!options.zetarisQueries?.length)
        throw new CollectionUnavailableError(
          'No approved pinned Zetaris queries are configured for evidence collection.',
        );
      return zetarisAdapter(scope.locations, {
        baseUrl: env.ZETARIS_BASE_URL ?? 'http://localhost:3000',
        username: env.ZETARIS_USERNAME,
        password: env.ZETARIS_PASSWORD,
        queries: [...options.zetarisQueries],
      });
    }
  }
}

export function createEvidenceCollectionTools(
  options: EvidenceCollectionToolOptions = {},
): ToolDefinition[] {
  const mode = options.mode ?? 'live';
  return [
    {
      id: EVIDENCE_COLLECTION_TOOL_ID,
      version: 'evidence-collection.v1',
      description:
        'Collect one authorized haze provider’s current window for 1–25 explicit locations. Retain raw bytes, provenance, coverage and unreviewed fact drafts.',
      mode,
      inputSchema: evidenceCollectionScopeSchema,
      outputSchema: collectionCaptureSchema,
      async execute(input, context) {
        const scope = evidenceCollectionScopeSchema.parse(input);
        context.signal.throwIfAborted();
        if (mode === 'live' && options.env?.SAMPLE_MODE === 'true')
          throw new CollectionUnavailableError(
            'SAMPLE_MODE=true disables live evidence collection.',
          );
        if (mode === 'replay' && !options.resolveSource)
          throw new CollectionUnavailableError(
            'Replay evidence collection needs an explicit source resolver; no live request was made.',
          );
        const source =
          mode === 'fixture'
            ? createFixtureCollectionAdapter(scope)
            : options.resolveSource
              ? await options.resolveSource(scope)
              : liveSource(scope, options);
        const now =
          mode === 'fixture'
            ? new Date('2026-10-24T12:00:00.000Z')
            : new Date();
        const result = await collectOnce(source, {
          now,
          signal: context.signal,
          runId: context.runId,
        });
        return collectionCaptureSchema.parse({
          schema_version: 'haze.evidence.collection.capture.v1',
          mode,
          evidence_origin:
            mode === 'fixture'
              ? 'synthetic_fixture'
              : (options.evidenceOrigin ?? 'external_source'),
          scope,
          collected_at: now.toISOString(),
          source: source.spec.source,
          selection: {
            query: source.spec.query,
            place_selector: source.spec.placeSelector,
            time_selector: source.spec.timeSelector,
          },
          evidence: result.evidence.map(({ record, raw }) => ({
            record,
            raw_base64: raw.toString('base64'),
          })),
          stations: result.stations,
          facts: result.facts,
          coverage: result.coverage,
        });
      },
    },
  ];
}

export function createEvidenceCollectionAssignments(): AssignmentDefinition[] {
  return [
    {
      id: 'evidence-collection.collect',
      version: 'evidence-collection.v1',
      capability: 'evidence-collection',
      agent: 'HazeOps',
      tools: [EVIDENCE_COLLECTION_TOOL_ID],
      instructions:
        'Collect only the explicitly selected provider and supplied locations. Retain exact raw evidence and source limitations; do not accept or independently verify the evidence.',
      async execute(services) {
        const scope = evidenceCollectionScopeSchema.safeParse(services.input);
        if (!scope.success) {
          services.question(
            'Provide an evidence-collection scope with one provider (open-meteo, openaq, firms or zetaris) and 1–25 unique locations including coordinates and country codes. Only the provider’s current documented window is supported.',
          );
          return {
            status: 'waiting_human',
            summary:
              'Waiting for an explicit bounded evidence-collection scope.',
            support: 'gap',
            uncertainty: ['Provider and valid location scope are required.'],
            outputs: [],
          };
        }
        try {
          const capture = collectionCaptureSchema.parse(
            await services.tool(EVIDENCE_COLLECTION_TOOL_ID, scope.data),
          );
          services.context.signal.throwIfAborted();
          if (JSON.stringify(capture.scope) !== JSON.stringify(scope.data))
            throw new Error(
              'Collection capture does not match the admitted assignment scope.',
            );
          const artifact = services.save(
            'evidence.collection.capture',
            capture,
            { evidence_origin: capture.evidence_origin },
          );
          return {
            status: 'completed',
            summary: `Retained ${capture.evidence.length} evidence record(s) from ${capture.source.name}; coverage ${capture.coverage.covered}/${capture.coverage.requested}. Evidence remains unreviewed.`,
            support: capture.evidence.length ? 'partial' : 'gap',
            uncertainty: [
              ...capture.coverage.gaps,
              'Evidence integrity does not establish source truth, scientific applicability or acceptance.',
            ],
            outputs: [artifact],
          };
        } catch (error) {
          services.context.signal.throwIfAborted();
          // Preserve transport failures and unknown outcomes in task execution receipts.
          // Only a definite, preflight configuration gap is a completed unavailable result.
          if (!(error instanceof CollectionUnavailableError)) throw error;
          const reason = error.message;
          const gap = services.save('evidence.gap', {
            source: EVIDENCE_COLLECTION_TOOL_ID,
            provider: scope.data.provider,
            reason,
            available: false,
          });
          return {
            status: 'completed',
            summary:
              'The selected collection source was unavailable; no substitute was queried.',
            support: 'gap',
            uncertainty: [reason],
            outputs: [gap],
          };
        }
      },
    },
  ];
}
