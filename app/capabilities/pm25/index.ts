import type { Artifact } from '../../contracts/artifacts.js';
import { artifactRefSchema } from '../../contracts/artifacts.js';
import { z } from 'zod';
import type {
  AssignmentDefinition,
  CapabilityDefinition,
  ExecutionMode,
  ToolDefinition,
} from '../../orchestration/ports.js';
import { framePm25Scope, pm25ScopeSchema } from './contracts.js';
import {
  PM25_SOURCE_ID,
  EvidenceSourceError,
  resolveEvidenceSource,
  type EvidenceSource,
} from './evidence.js';
import { createFixtureCapture } from './fixtures.js';
import {
  analyzePm25,
  captureSchema,
  independentlyCheckPm25,
  pm25AnalysisSchema,
} from './methods.js';
import { pm25WorldModelAdapter } from './world.js';

export { framePm25Scope } from './contracts.js';
export { analyzePm25, independentlyCheckPm25 } from './methods.js';
export { pm25WorldModelAdapter } from './world.js';

export function createPm25Capability(): CapabilityDefinition {
  return {
    prerequisites: [
      {
        definition_id: 'pm25.analyze',
        depends_on_definitions: ['pm25.retrieve'],
      },
      {
        definition_id: 'pm25.check',
        depends_on_definitions: ['pm25.retrieve'],
      },
    ],
    review_requirements: [
      {
        artifact_kind: 'pm25.analysis',
        review_definition_id: 'pm25.check',
        producer_definition_ids: ['pm25.analyze'],
      },
    ],
    peer_requirements: [
      {
        definitions: ['pm25.analyze', 'pm25.check'],
        purpose: 'numerical-check',
      },
    ],
    normalizeReview(artifact) {
      if (artifact.kind !== 'review') return undefined;
      const content = z
        .object({
          verdict: z.enum(['supported', 'rejected']),
          reviewed_artifacts: z.array(artifactRefSchema),
          limitations: z.array(z.string()).default([]),
        })
        .safeParse(artifact.content);
      return content.success
        ? {
            verdict: content.data.verdict,
            artifacts: content.data.reviewed_artifacts,
            limitations: content.data.limitations,
          }
        : undefined;
    },
    card: {
      id: 'pm25-evidence-summary',
      version: '4',
      purpose:
        'Investigate bounded modeled PM2.5 evidence with reproducible analysis and independent numerical checking.',
      work_products: [
        'pm25.capture',
        'pm25.analysis',
        'review',
        'evidence.gap',
      ],
      required_tools: [PM25_SOURCE_ID],
      roles: ['HazeOps', 'WorkerShield', 'EvidenceCritic'],
      readiness: 'implemented',
      limitations: [
        'Only stored Open-Meteo/CAMS instantaneous modeled samples are available.',
        'Observation and attribution evidence remain explicitly unresolved.',
        'Live readiness requires a captured configured model/tool execution.',
      ],
    },
    matches: (request) =>
      /PM2[.]?5/iu.test(request.objective) &&
      !/^\s*(?:please\s+)?(?:explain|describe|interpret|what|why|how)\b.*\b(?:report|source|supplied|imported)\b/iu.test(
        request.objective,
      ),
    worldModel: pm25WorldModelAdapter,
    assignments(request) {
      let input: unknown;
      try {
        input = framePm25Scope(request);
      } catch {
        input = { needs_scope: true };
      }
      return [
        {
          key: 'selection',
          definition_id: 'pm25.retrieve',
          brief: 'Retrieve the exact authorized modeled PM2.5 selection.',
          depends_on: [],
          input,
        },
        {
          key: 'analysis',
          definition_id: 'pm25.analyze',
          brief:
            'Calculate reproducible coverage and range from the retained selection.',
          depends_on: ['selection'],
          input,
        },
        {
          key: 'check',
          definition_id: 'pm25.check',
          brief:
            'Independently check selection, counts, missingness, range and citations through a bounded peer exchange.',
          depends_on: ['selection'],
          input,
        },
        {
          key: 'observation-gap',
          definition_id: 'pm25.observation-gap',
          brief: 'Record unavailable observation and attribution evidence.',
          depends_on: [],
          input,
        },
      ];
    },
  };
}

export function createPm25Tools(
  options: {
    mode?: ExecutionMode;
    source?: EvidenceSource;
    env?: NodeJS.ProcessEnv;
  } = {},
): ToolDefinition[] {
  const mode = options.mode ?? 'live';
  const source = options.source ?? resolveEvidenceSource(options.env ?? {});
  return [
    {
      id: PM25_SOURCE_ID,
      version: '4',
      mode,
      manager_read_only: true,
      description:
        'Read bounded modeled PM2.5 evidence for a town and UTC interval; SQL is constructed by this capability.',
      inputSchema: pm25ScopeSchema,
      outputSchema: captureSchema,
      async execute(input, context) {
        const scope = pm25ScopeSchema.parse(input);
        if (mode === 'replay' && !options.source)
          throw new EvidenceSourceError(
            'No explicit PM2.5 replay source is configured; no live request was made.',
            'unavailable',
          );
        const capture =
          mode === 'fixture'
            ? createFixtureCapture(scope)
            : await source.retrieve(scope, context.signal);
        if (capture.mode !== mode)
          throw new EvidenceSourceError(
            'Capture execution mode does not match the admitted tool mode.',
            'invalid_evidence',
          );
        // Raw-row linkage is validated before any work product is accepted.
        analyzePm25(capture, scope);
        return capture;
      },
    },
  ];
}

function exact(inputs: Artifact[], kind: string): Artifact {
  const found = inputs.find((artifact) => artifact.kind === kind);
  if (!found) throw new Error(`Missing exact input artifact ${kind}.`);
  return found;
}

export function createPm25Assignments(): AssignmentDefinition[] {
  const capability = 'pm25-evidence-summary';
  return [
    {
      id: 'pm25.retrieve',
      version: '4',
      capability,
      agent: 'HazeOps',
      tools: [PM25_SOURCE_ID],
      instructions:
        'Retrieve only the bounded authorized PM2.5 scope. Preserve raw selection and model semantics.',
      async execute(services) {
        const scope = pm25ScopeSchema.safeParse(services.input);
        if (!scope.success) {
          services.question(
            'Which town and UTC start/end (end exclusive, at most 31 days) should the PM2.5 investigation cover? Provide them in the correction scope.',
          );
          return {
            status: 'waiting_human',
            summary: 'Waiting for an explicit PM2.5 scope.',
            support: 'gap',
            uncertainty: ['Location and period are missing or conflicting.'],
            outputs: [],
          };
        }
        try {
          const capture = captureSchema.parse(
            await services.tool(PM25_SOURCE_ID, scope.data),
          );
          const artifact = services.save('pm25.capture', capture, {
            evidence_origin:
              capture.evidence_origin === 'synthetic_fixture'
                ? 'synthetic_fixture'
                : 'external_source',
          });
          return {
            status: 'completed',
            summary:
              'Retained exact modeled PM2.5 source selection; provider issuance and observation coverage are unknown.',
            support: 'partial',
            uncertainty: [
              'This selection contains model output, not observations or hourly averages.',
            ],
            outputs: [artifact],
          };
        } catch (error) {
          services.context.signal.throwIfAborted();
          if (
            error instanceof EvidenceSourceError &&
            error.outcome === 'unknown'
          )
            throw error;
          const message =
            error instanceof Error ? error.message : 'Source unavailable.';
          const gap = services.save('evidence.gap', {
            source: PM25_SOURCE_ID,
            reason: message,
            available: false,
          });
          return {
            status: 'completed',
            summary:
              'The modeled evidence source was unavailable; no substitute was queried.',
            support: 'gap',
            uncertainty: [message],
            outputs: [gap],
          };
        }
      },
    },
    {
      id: 'pm25.analyze',
      version: '4',
      capability,
      agent: 'WorkerShield',
      tools: [],
      instructions:
        'Use registered deterministic coverage calculation on exact pinned evidence. Never fabricate unavailable evidence.',
      execute(services) {
        if (
          !services.context.inputs.some(
            (input) => input.kind === 'pm25.capture',
          )
        )
          return {
            status: 'completed',
            summary:
              'Numerical analysis unavailable because no accepted source selection exists.',
            support: 'gap',
            uncertainty: ['No source capture to analyze.'],
            outputs: [],
          };
        const reviewer = services.context.peers.find(
          (peer) => peer.definition_id === 'pm25.check',
        );
        if (!reviewer)
          throw new Error(
            'A separate registered numerical reviewer is required.',
          );
        const saved = services.context.outputs
          .map((ref) => services.read(ref))
          .find((artifact) => artifact.kind === 'pm25.analysis');
        if (saved) {
          const reply = services
            .inbox()
            .find((message) => message.sender === reviewer.id);
          if (!reply)
            return {
              status: 'waiting_peer',
              summary: 'Waiting for the independent numerical review.',
              support: 'partial',
              uncertainty: [],
              outputs: [saved],
            };
          const analysis = pm25AnalysisSchema.parse(saved.content);
          return {
            status: 'completed',
            summary: analysis.findings[0]!.text,
            support:
              analysis.coverage.status === 'available'
                ? 'supported'
                : 'partial',
            uncertainty: analysis.unresolved_gaps,
            outputs: [saved],
          };
        }
        const capture = captureSchema.parse(
          exact(services.context.inputs, 'pm25.capture').content,
        );
        const analysis = analyzePm25(
          capture,
          pm25ScopeSchema.parse(services.input),
        );
        const artifact = services.save('pm25.analysis', analysis);
        services.message(
          reviewer.id,
          'numerical-check',
          JSON.stringify({
            artifact: {
              id: artifact.id,
              version: artifact.version,
              sha256: artifact.sha256,
            },
          }),
        );
        return {
          status: 'waiting_peer',
          summary:
            'Analysis saved; waiting for independent numerical checking.',
          support: 'partial',
          uncertainty: [],
          outputs: [artifact],
        };
      },
    },
    {
      id: 'pm25.check',
      version: '4',
      capability,
      agent: 'EvidenceCritic',
      tools: [],
      instructions:
        'Independently validate retained numerical work. A producer cannot approve its own work. Reject any failed check.',
      execute(services) {
        const inputs = services.context.inputs;
        if (!inputs.some((input) => input.kind === 'pm25.capture'))
          return {
            status: 'completed',
            summary: 'Independent review has no accepted analysis to check.',
            support: 'gap',
            uncertainty: ['No numerical analysis available.'],
            outputs: [],
          };
        const producer = services.context.peers.find(
          (peer) => peer.definition_id === 'pm25.analyze',
        );
        if (!producer)
          throw new Error(
            'A separate registered numerical producer is required.',
          );
        const request = services
          .inbox()
          .find((message) => message.sender === producer.id);
        if (!request)
          return {
            status: 'waiting_peer',
            summary:
              'Waiting for an exact analysis reference from the producer.',
            support: 'partial',
            uncertainty: [],
            outputs: [],
          };
        const shared = JSON.parse(request.text) as {
          artifact: { id: string; version: number; sha256: string };
        };
        const capture = exact(inputs, 'pm25.capture');
        const analysis = services.read(shared.artifact);
        if (
          analysis.kind !== 'pm25.analysis' ||
          analysis.assignment_id !== producer.id
        )
          throw new Error(
            'Peer reference does not name the expected producer analysis.',
          );
        const checked = independentlyCheckPm25(
          capture.content,
          analysis.content,
          pm25ScopeSchema.parse(services.input),
        );
        // The target is a named persisted assignment instance, never an agent role.
        if (analysis.assignment_id)
          services.message(
            analysis.assignment_id,
            'numerical-check',
            checked.valid
              ? 'Independent counts, range, missingness and source-link checks passed. Observation and attribution evidence remain unavailable.'
              : 'Independent numerical checks failed; exclude this analysis from synthesis.',
          );
        const artifact = services.save('review', {
          ...checked,
          verdict: checked.valid ? 'supported' : 'rejected',
          reviewer_role: 'EvidenceCritic',
          reviewed_artifacts: [capture, analysis].map(
            ({ id, version, sha256 }) => ({ id, version, sha256 }),
          ),
        });
        const parsed = pm25AnalysisSchema.parse(analysis.content);
        return {
          status: 'completed',
          summary: checked.valid
            ? `Independent numerical checks passed. ${parsed.findings[0]!.text}`
            : 'Numerical work rejected by the independent checker.',
          support: checked.valid ? 'supported' : 'gap',
          uncertainty: [...checked.limitations, ...checked.findings],
          outputs: [artifact],
        };
      },
    },
    {
      id: 'pm25.observation-gap',
      version: '4',
      capability,
      agent: 'HazeOps',
      tools: [],
      instructions:
        'State unavailable observation and attribution branches without claiming they were searched.',
      execute(services) {
        const artifact = services.save('evidence.gap', {
          observation: 'unavailable',
          attribution: 'unavailable',
          reason:
            'No observation or causal attribution tool is registered. Absence of evidence elsewhere is not established.',
        });
        return {
          status: 'completed',
          summary:
            'Observation and attribution evidence are unavailable within the registered tools.',
          support: 'gap',
          uncertainty: [
            'No causal attribution, health advice or operational decision is supported.',
          ],
          outputs: [artifact],
        };
      },
    },
  ];
}
