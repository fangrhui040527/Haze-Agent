import { z } from 'zod';
import type { Artifact } from '../../contracts/artifacts.js';
import { artifactRefSchema } from '../../contracts/artifacts.js';
import { TaskError } from '../../contracts/tasks.js';
import type {
  AssignmentDefinition,
  AssignmentOutput,
  AssignmentServices,
  CapabilityDefinition,
  ExecutionMode,
  ToolDefinition,
} from '../../orchestration/ports.js';
import {
  framePm25Scope,
  pm25ScopeSchema,
  type Pm25Scope,
} from './contracts.js';
import {
  PM25_SOURCE_ID,
  EvidenceSourceError,
  resolveEvidenceSource,
  type EvidenceCapture,
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

/** Registered deterministic methods the specialists call rather than reason out. */
export const PM25_COVERAGE_ID = 'pm25-coverage-range';
export const PM25_CHECK_ID = 'pm25-independent-check';
const PM25_SOURCE_UNAVAILABLE = 'pm25_source_unavailable';

/** Both methods read their evidence from pinned inputs; only scope is supplied. */
const scopedToolInput = z.strictObject({ scope: pm25ScopeSchema });

const pm25CheckSchema = z.strictObject({
  checks: z.array(z.string().min(1).max(4096)).max(32),
  findings: z.array(z.string().min(1).max(4096)).max(64),
  valid: z.boolean(),
  limitations: z.array(z.string().min(1).max(4096)).max(32),
  verdict: z.enum(['supported', 'rejected']),
  reviewer_role: z.literal('EvidenceCritic'),
  reviewed_artifacts: z.array(artifactRefSchema),
});

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
      version: '5',
      purpose:
        'Investigate bounded modeled PM2.5 evidence with reproducible analysis and independent numerical checking.',
      work_products: [
        'pm25.capture',
        'pm25.analysis',
        'review',
        'evidence.gap',
      ],
      required_tools: [PM25_SOURCE_ID, PM25_COVERAGE_ID, PM25_CHECK_ID],
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
            'Independently check selection, counts, missingness, range and citations, then report the verdict to the producer.',
          // The analysis is pinned as an input because a bounded local loop
          // cannot dereference an artifact reference delivered by message.
          depends_on: ['selection', 'analysis'],
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
      version: '5',
      mode,
      manager_read_only: true,
      output_artifact_kind: 'pm25.capture',
      description:
        'Read bounded modeled PM2.5 evidence for a town and UTC interval; SQL is constructed by this capability.',
      inputSchema: pm25ScopeSchema,
      outputSchema: captureSchema,
      async execute(input, context) {
        const scope = pm25ScopeSchema.parse(input);
        if (mode === 'replay' && !options.source)
          throw new TaskError(
            503,
            PM25_SOURCE_UNAVAILABLE,
            'No explicit PM2.5 replay source is configured; no live request was made.',
          );
        let capture: EvidenceCapture;
        try {
          capture =
            mode === 'fixture'
              ? createFixtureCapture(scope)
              : await source.retrieve(scope, context.signal);
        } catch (error) {
          context.signal.throwIfAborted();
          // TaskError codes survive operation-receipt serialization. Preserve
          // this confirmed gap across recovery without relabelling unknowns.
          if (
            error instanceof EvidenceSourceError &&
            error.code === 'unavailable' &&
            error.outcome === 'failed'
          )
            throw new TaskError(503, PM25_SOURCE_UNAVAILABLE, error.message);
          throw error;
        }
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
    {
      id: PM25_COVERAGE_ID,
      version: '3',
      mode,
      output_artifact_kind: 'pm25.analysis',
      description:
        'Calculate reproducible coverage, missing sample slots and value range from the pinned PM2.5 capture. Numerical claims must come from this method, never from prose.',
      inputSchema: scopedToolInput,
      outputSchema: pm25AnalysisSchema,
      execute(input, context) {
        const { scope } = scopedToolInput.parse(input);
        const capture = captureSchema.parse(
          exact(context.inputs, 'pm25.capture').content,
        );
        return Promise.resolve(analyzePm25(capture, scope));
      },
    },
    {
      id: PM25_CHECK_ID,
      version: '3',
      mode,
      output_artifact_kind: 'review',
      description:
        'Independently recompute counts, missingness, range and citation linkage from the raw capture and compare them against the pinned analysis. Returns valid=false with findings when any check fails.',
      inputSchema: scopedToolInput,
      // The method owns the verdict and the exact revisions it checked.
      outputSchema: pm25CheckSchema,
      execute(input, context) {
        const { scope } = scopedToolInput.parse(input);
        const capture = exact(context.inputs, 'pm25.capture');
        const analysis = exact(context.inputs, 'pm25.analysis');
        // Independence is enforced here, not left to a model's discretion.
        if (analysis.assignment_id === context.assignmentId)
          throw new Error(
            'A producer cannot independently check its own analysis.',
          );
        const checked = independentlyCheckPm25(
          capture.content,
          analysis.content,
          scope,
        );
        return Promise.resolve({
          ...checked,
          verdict: checked.valid
            ? ('supported' as const)
            : ('rejected' as const),
          reviewer_role: 'EvidenceCritic' as const,
          reviewed_artifacts: [capture, analysis].map(
            ({ id, version, sha256 }) => ({ id, version, sha256 }),
          ),
        });
      },
    },
  ];
}

function exact(inputs: Artifact[], kind: string): Artifact {
  const found = inputs.find((artifact) => artifact.kind === kind);
  if (!found) throw new Error(`Missing exact input artifact ${kind}.`);
  return found;
}

const scopeQuestion =
  'Which town and explicit UTC start/end should the PM2.5 selection use? The end is exclusive and the positive interval must be at most 31 days. Resolve any conflicting scope before retrieval.';

function admittedScope(services: AssignmentServices): Pm25Scope | null {
  const result = pm25ScopeSchema.safeParse(services.input);
  if (result.success) return result.data;
  services.question(scopeQuestion);
  return null;
}

function scopeWait(): AssignmentOutput {
  return {
    status: 'waiting_human',
    summary: scopeQuestion,
    support: 'gap',
    uncertainty: [scopeQuestion],
    outputs: [],
  };
}

function evidenceGap(reason: string): AssignmentOutput {
  return {
    status: 'completed',
    summary: reason,
    support: 'gap',
    uncertainty: [reason],
    outputs: [],
  };
}

export function createPm25Assignments(): AssignmentDefinition[] {
  const capability = 'pm25-evidence-summary';
  return [
    {
      id: 'pm25.retrieve',
      version: '5',
      capability,
      agent: 'HazeOps',
      tools: [PM25_SOURCE_ID],
      instructions:
        'Retrieve the admitted modeled PM2.5 selection. Read the pinned input. When it carries a location and an explicit UTC period, call the registered source tool once with exactly that scope, then return one action whose "type" is "save_tool_result", whose "kind" is "pm25.capture" and whose "tool_action_id" is the id of that tool action, and finish citing the saved artifact. When the pinned input instead reports that scope is missing or conflicting, ask one question naming what is required (town, UTC start, UTC end, end exclusive, at most 31 days) and stop. Never widen, narrow or invent a scope. Never retype row values into a saved artifact. When the source is unavailable, say so and finish with support "gap"; never substitute another source.',
      async execute(services) {
        const scope = admittedScope(services);
        if (!scope) return scopeWait();
        let result: unknown;
        try {
          result = await services.tool(PM25_SOURCE_ID, scope);
        } catch (error) {
          // Only a known unavailable source is a gap. Ambiguous dispatches,
          // cancellation and invalid evidence retain their failure authority.
          if (
            error instanceof TaskError &&
            error.code === PM25_SOURCE_UNAVAILABLE &&
            !('outcome' in error && error.outcome === 'unknown')
          )
            return evidenceGap(
              'The admitted PM2.5 source is unavailable; no capture was retained and no alternate source was queried.',
            );
          throw error;
        }
        const capture = captureSchema.parse(result);
        const artifact = services.save('pm25.capture', result, {
          evidence_origin:
            capture.mode === 'fixture' ||
            capture.evidence_origin === 'synthetic_fixture'
              ? 'synthetic_fixture'
              : 'external_source',
        });
        return {
          status: 'completed',
          summary: 'Retained the exact authorized modeled PM2.5 selection.',
          support: 'supported',
          uncertainty: capture.limitations,
          outputs: [artifact],
        };
      },
    },
    {
      id: 'pm25.analyze',
      version: '5',
      capability,
      agent: 'WorkerShield',
      tools: [PM25_COVERAGE_ID],
      instructions:
        'Establish how far the retained evidence actually reaches, and refuse to let it be read as more than it is. Call the registered coverage tool once with the admitted scope, then return one action whose "type" is "save_tool_result", whose "kind" is "pm25.analysis" and whose "tool_action_id" is that tool action id, then finish citing that artifact. Every number you state must come from the tool output; calculate nothing yourself. Set support to "supported" only when the returned coverage status is available, otherwise "partial", and put the thin parts in uncertainty rather than withholding the result. If no capture is pinned, finish with support "gap" and state that no accepted selection exists. Never present modeled output as observation, never infer cause from correlation, and never give health or operational advice.',
      async execute(services) {
        const scope = admittedScope(services);
        if (!scope) return scopeWait();
        if (
          !services.context.inputs.some((item) => item.kind === 'pm25.capture')
        )
          return evidenceGap(
            'No accepted PM2.5 selection is pinned for analysis.',
          );
        const result = await services.tool(PM25_COVERAGE_ID, { scope });
        const analysis = pm25AnalysisSchema.parse(result);
        const artifact = services.save('pm25.analysis', result);
        return {
          status: 'completed',
          summary: analysis.findings.map((finding) => finding.text).join('\n'),
          support:
            analysis.coverage.status === 'available' ? 'supported' : 'partial',
          uncertainty: analysis.unresolved_gaps,
          outputs: [artifact],
        };
      },
    },
    {
      id: 'pm25.check',
      version: '5',
      capability,
      agent: 'EvidenceCritic',
      tools: [PM25_CHECK_ID],
      instructions:
        'Independently check the numerical work produced by another assignment. Call the registered independent-check tool once with the admitted scope; it recomputes counts, missingness, range and citation linkage from the raw capture and compares them against the pinned analysis. Judge on its output alone and never on figures you read yourself. Persist the outcome by returning one action whose "type" is "save_tool_result", whose "kind" is "review" and whose "tool_action_id" is that tool action id. The verdict belongs in that saved review: the producing assignment has already completed, because its analysis is a pinned dependency, so do not message it. Finish with support "supported" when valid is true and "gap" when it is false, carrying the returned limitations into uncertainty. You cannot approve work you produced; the tool refuses that case. Keep numerical checking separate from judging whether prose is entailed, and claim no scientific review.',
      async execute(services) {
        const scope = admittedScope(services);
        if (!scope) return scopeWait();
        if (
          !['pm25.capture', 'pm25.analysis'].every((kind) =>
            services.context.inputs.some((item) => item.kind === kind),
          )
        )
          return evidenceGap(
            'The exact PM2.5 capture and analysis are not both pinned for independent review.',
          );
        const result = await services.tool(PM25_CHECK_ID, { scope });
        const check = pm25CheckSchema.parse(result);
        const artifact = services.save('review', result);
        return {
          status: 'completed',
          summary: check.valid
            ? 'Independent numerical checks passed for the exact retained PM2.5 capture and analysis. No scientific review was performed.'
            : 'Independent numerical checks rejected the retained PM2.5 analysis. No scientific review was performed.',
          support: check.valid ? 'supported' : 'gap',
          uncertainty: check.limitations,
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
