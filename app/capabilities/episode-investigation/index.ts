import type {
  AssignmentDefinition,
  AssignmentPlan,
  CapabilityDefinition,
} from '../../orchestration/ports.js';
import { contractHash, parseContractJson } from '../../contracts/json.js';
import { artifactRefSchema } from '../../contracts/artifacts.js';
import {
  episodeContextSchema,
  episodeEvidenceGapSchema,
  episodeScopeSchema,
} from './contracts.js';
import { episodeInvestigationWorldModelAdapter } from './world.js';

/** Domain methods enter through registered templates; the general engine knows no domain fields. */
export function createEpisodeInvestigationCapability(
  methods: AssignmentPlan[] = [],
): CapabilityDefinition {
  return {
    peer_requirements: [
      {
        definitions: [
          'episode-investigation.gaps',
          'episode-investigation.review',
        ],
        purpose: 'episode-review',
      },
    ],
    card: {
      id: 'episode-investigation',
      version: 'episode-investigation.v3',
      purpose:
        'Investigate an episode using available reproducible methods and separate unavailable evidence branches.',
      work_products: [
        'Episode investigation',
        'Observation and attribution evidence gaps',
      ],
      required_tools: [],
      roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
      readiness: 'implemented',
      limitations: [
        'Observation and causal-attribution adapters are not configured.',
      ],
    },
    matches: (request) =>
      /episode|investigat|haze|pm2\.?5/i.test(request.objective) &&
      !/^\s*(?:please\s+)?(?:explain|describe|interpret|what|why|how)\b.*\b(?:report|source|supplied|imported)\b/iu.test(
        request.objective,
      ),
    worldModel: episodeInvestigationWorldModelAdapter,
    assignments: (request) => [
      ...methods,
      {
        key: 'evidence-gaps',
        definition_id: 'episode-investigation.gaps',
        brief: request.objective,
        depends_on: [],
        input: request.scope ?? null,
      },
      {
        key: 'context-review',
        definition_id: 'episode-investigation.review',
        brief:
          'Independently verify the exact episode scope, linked analysis references, and unresolved evidence-availability branches.',
        depends_on: ['evidence-gaps'],
      },
    ],
  };
}
export function createEpisodeInvestigationAssignments(): AssignmentDefinition[] {
  return [
    {
      id: 'episode-investigation.gaps',
      version: 'episode-gaps.v3',
      capability: 'episode-investigation',
      agent: 'WorkerShield',
      tools: [],
      instructions:
        'Report unavailable observation and attribution evidence without implying absence in the world.',
      execute: (services) => {
        const scope = episodeScopeSchema.safeParse(services.input);
        const linkedAnalyses = services.context.inputs
          .filter((artifact) => artifact.kind.endsWith('.analysis'))
          .map(({ id, version, sha256 }) => ({ id, version, sha256 }));
        const context = scope.success
          ? services.save('episode-investigation.context', {
              schema_version: 'haze.episode.context.v1',
              scope: scope.data,
              linked_analyses: linkedAnalyses,
              evidence: services.context.inputs.map(
                ({ id, version, sha256 }) => ({
                  id,
                  version,
                  sha256,
                }),
              ),
              limitations: [
                'Episode identity and geography are supplied labels, not independently geocoded facts.',
                'Linked analyses remain their original immutable artifacts.',
              ],
            })
          : undefined;
        const branches = [
          {
            id: 'observations' as const,
            status: 'unresolved' as const,
            source_availability: 'not_configured' as const,
            reason:
              'No observation adapter is configured; observational coverage remains unresolved.',
          },
          {
            id: 'attribution' as const,
            status: 'unresolved' as const,
            source_availability: 'not_configured' as const,
            reason:
              'No independent attribution source is configured; causes of the episode remain unresolved.',
          },
        ];
        const typedGap = services.save('episode-investigation.evidence-gaps', {
          schema_version: 'haze.episode.evidence-gaps.v1',
          ...(scope.success ? { scope: scope.data } : {}),
          scope_status: scope.success ? 'scoped' : 'unresolved',
          branches,
          limitations: [
            'An unresolved branch is not evidence that the event or measurements are absent.',
          ],
        });
        const gaps = [...branches.map((branch) => branch.reason)];
        const artifact = services.save('evidence.gap', {
          status: 'partial',
          gaps,
        });
        const review = services.context.peers.find(
          (peer) => peer.definition_id === 'episode-investigation.review',
        );
        if (review)
          services.message(
            review.id,
            'episode-review',
            JSON.stringify({
              ...(context
                ? {
                    context: {
                      id: context.id,
                      version: context.version,
                      sha256: context.sha256,
                    },
                  }
                : {}),
              gap_report: {
                id: typedGap.id,
                version: typedGap.version,
                sha256: typedGap.sha256,
              },
              linked_analyses: linkedAnalyses,
            }),
          );
        return {
          status: 'completed',
          summary: [
            ...(scope.success
              ? ['Episode context was recorded with its exact supplied scope.']
              : ['Episode scope is unresolved; no scope was inferred.']),
            ...gaps,
          ].join(' '),
          support: 'gap',
          uncertainty: gaps,
          outputs: [artifact, typedGap, ...(context ? [context] : [])],
        };
      },
    },
    {
      id: 'episode-investigation.review',
      version: 'episode-review.v1',
      capability: 'episode-investigation',
      agent: 'EvidenceCritic',
      tools: [],
      instructions:
        'Check exact episode references, scope consistency, and explicitly unresolved source-availability branches only. Do not validate causal attribution or scientific conclusions.',
      execute: (services) => {
        const producer = services.context.peers.find(
          (peer) => peer.definition_id === 'episode-investigation.gaps',
        );
        const message = services
          .inbox()
          .find((item) => item.sender === producer?.id);
        if (!message)
          return {
            status: 'waiting_peer',
            summary: 'Waiting for the exact episode context and gap report.',
            support: 'partial',
            uncertainty: [],
            outputs: [],
          };
        let payload: unknown;
        try {
          payload = parseContractJson(message.text);
        } catch {
          throw new Error('Episode review message is not valid contract JSON.');
        }
        const messageSchema = episodeContextSchema
          .pick({ linked_analyses: true })
          .extend({
            context: artifactRefSchema.optional(),
            gap_report: artifactRefSchema,
          })
          .strict();
        const parsed = messageSchema.safeParse(payload);
        if (!parsed.success)
          throw new Error(
            'Episode review message has an invalid exact reference.',
          );
        const gapArtifact = services.read(parsed.data.gap_report);
        const gap = episodeEvidenceGapSchema.safeParse(gapArtifact.content);
        if (!gap.success)
          throw new Error(
            'Episode gap report does not match its strict schema.',
          );
        if (
          gap.data.scope_status !== 'scoped' ||
          gap.data.scope === undefined ||
          parsed.data.context === undefined
        )
          return {
            status: 'completed',
            summary:
              'The evidence branches remain unresolved because the episode scope is not complete.',
            support: 'gap',
            uncertainty: [
              'No candidate can be formed without a complete episode scope and exact context record.',
            ],
            outputs: [],
          };
        const contextArtifact = services.read(parsed.data.context);
        const context = episodeContextSchema.safeParse(contextArtifact.content);
        if (
          !context.success ||
          contractHash(context.data.scope) !== contractHash(gap.data.scope) ||
          contractHash(context.data.linked_analyses) !==
            contractHash(parsed.data.linked_analyses)
        )
          throw new Error(
            'Episode context and gap scope or analysis refs differ.',
          );
        const analyses = parsed.data.linked_analyses.map((ref) =>
          services.read(ref),
        );
        if (analyses.some((analysis) => !analysis.kind.endsWith('.analysis')))
          throw new Error(
            'Linked episode reference is not an analysis artifact.',
          );
        const reviewArtifact = services.save('episode-investigation.review', {
          schema_version: 'haze.episode.review.v1',
          context: parsed.data.context,
          gap_report: parsed.data.gap_report,
          reviewed_analyses: parsed.data.linked_analyses,
          checked_scope: context.data.scope,
          reviewed_branches: gap.data.branches.map((branch) => ({
            id: branch.id,
            source_availability: branch.source_availability,
            status: 'unresolved' as const,
          })),
          status: 'partial',
          limitations: [
            'Review validates exact references and declared unresolved branches only; it does not establish source authenticity, event occurrence, causal attribution, or scientific applicability.',
          ],
        });
        return {
          status: 'completed',
          summary:
            'Exact episode scope and linked analysis references were checked; unresolved evidence branches remain unresolved.',
          support: 'supported',
          uncertainty: [
            'Observation coverage and causal attribution are not established.',
          ],
          outputs: [reviewArtifact],
        };
      },
    },
  ];
}
