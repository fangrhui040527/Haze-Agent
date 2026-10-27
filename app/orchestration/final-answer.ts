import type { Artifact, ArtifactRef } from '../contracts/artifacts.js';
import type { ArtifactReviewCheck } from '../contracts/manager.js';
import type { TaskRecord, TaskResult } from '../contracts/tasks.js';
import type {
  ExecutionMode,
  ExecutionRegistry,
  FinalAnswerSection,
  ReadonlyEvidenceStore,
} from './ports.js';

const ANSWER_LIMIT = 32_000;
const LINE_LIMIT = 2_000;
const LINES_PER_SECTION = 80;

export interface RenderedFinalAnswer {
  answer: string;
  capabilities: string[];
  gaps: string[];
}

/** Exact arithmetic display: half-up decimal rounding of numerator/denominator. */
export function roundedPercent(
  numerator: bigint,
  denominator: bigint,
  places = 3,
): string {
  if (denominator === 0n) throw new Error('percent_denominator_zero');
  const negative = numerator < 0n !== denominator < 0n && numerator !== 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const scale = 10n ** BigInt(places);
  const scaled = (n * 100n * scale * 2n + d) / (d * 2n);
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(places, '0');
  return `${negative && scaled !== 0n ? '-' : ''}${whole}${places ? `.${fraction}` : ''}`;
}

/** Quantitative workflows are the planned capabilities with a registered renderer. */
export function quantitativeCapabilities(
  task: TaskRecord,
  registry: ExecutionRegistry,
): string[] {
  return [
    ...new Set(
      task.assignments
        .filter(
          (assignment) =>
            assignment.run_id === task.current_run_id &&
            assignment.objective_revision === task.objective_revision &&
            assignment.role !== 'Manager' &&
            !['stale', 'cancelled'].includes(assignment.status) &&
            registry.finalRenderers.has(assignment.capability),
        )
        .map((assignment) => assignment.capability),
    ),
  ].sort();
}

/**
 * Builds the saved factual answer from registered deterministic renderers. The
 * caller has already validated the exact closure and independent reviews.
 * Returns undefined for conceptual work, whose synthesis behavior is unchanged.
 */
export function renderFinalAnswer(input: {
  task: TaskRecord;
  registry: ExecutionRegistry;
  selected: readonly ArtifactRef[];
  closure: readonly Artifact[];
  reviews: readonly ArtifactReviewCheck[];
  citations: TaskResult['sources'];
  store: ReadonlyEvidenceStore;
  mode: ExecutionMode;
  read(ref: ArtifactRef): Artifact;
}): RenderedFinalAnswer | undefined {
  const capabilities = quantitativeCapabilities(input.task, input.registry);
  if (!capabilities.length) return undefined;
  const byId = new Map(
    input.closure.map((artifact) => [artifact.id, artifact]),
  );
  const producerCapability = new Map(
    input.task.assignments.map((assignment) => [
      assignment.id,
      assignment.capability,
    ]),
  );
  const sections: FinalAnswerSection[] = [];
  const limitations: string[] = [];
  const gaps: string[] = [];
  // Pass an actual inspection facade, not a mutable TaskStore with a narrower
  // TypeScript annotation. Registered renderers receive no write authority.
  const store: ReadonlyEvidenceStore = Object.freeze({
    read: input.store.read.bind(input.store),
    artifact: input.store.artifact.bind(input.store),
    world: Object.freeze({
      lookup: input.store.world.lookup.bind(input.store.world),
      activeHolds: input.store.world.activeHolds.bind(input.store.world),
    }),
  });
  for (const capability of capabilities) {
    const renderer = input.registry.finalRenderers.get(capability)!;
    const label =
      input.registry.capabilities.get(capability)?.card.id ?? capability;
    // A renderer sees only exact selected or supporting artifacts that its own
    // capability produced, so a mixed answer cannot borrow another workflow's figures.
    const artifacts = [
      ...new Map(
        input.closure
          .filter(
            (artifact) =>
              renderer.artifact_kinds.includes(artifact.kind) &&
              artifact.assignment_id !== undefined &&
              producerCapability.get(artifact.assignment_id) === capability,
          )
          .map((artifact) => [artifact.id, byId.get(artifact.id)!]),
      ).values(),
    ];
    if (!artifacts.length) {
      const gap = `No independently reviewed ${label} output was selected; no ${label} figure is reported.`;
      gaps.push(gap);
      sections.push({ heading: `${label}: gap`, lines: [gap] });
      continue;
    }
    const rendered = renderer.render({
      task: input.task,
      artifacts,
      closure: input.closure,
      reviews: input.reviews,
      services: { store, mode: input.mode, read: (ref) => input.read(ref) },
    });
    sections.push(...rendered.sections);
    limitations.push(...rendered.limitations);
    gaps.push(...rendered.gaps);
  }
  if (input.citations.length)
    sections.push({
      heading: 'Sources',
      lines: input.citations.map(
        (citation) => `[${citation.id}] ${citation.label}`,
      ),
    });
  const unique = [...new Set(limitations)];
  if (unique.length) sections.push({ heading: 'Limitations', lines: unique });
  return {
    answer: compose(sections),
    capabilities,
    gaps: [...new Set(gaps)],
  };
}

function compose(sections: FinalAnswerSection[]): string {
  const blocks = sections.map((section) => {
    const lines = section.lines
      .slice(0, LINES_PER_SECTION)
      .map((line) =>
        line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT - 1)}…` : line,
      );
    if (section.lines.length > LINES_PER_SECTION)
      lines.push(
        `${section.lines.length - LINES_PER_SECTION} further rows are retained in the cited artifacts.`,
      );
    return [section.heading, ...lines.map((line) => `- ${line}`)].join('\n');
  });
  let answer = '';
  for (const [index, block] of blocks.entries()) {
    const next = answer ? `${answer}\n\n${block}` : block;
    if (next.length > ANSWER_LIMIT - 200) {
      answer += `\n\n${blocks.length - index} further sections are retained in the cited artifacts.`;
      break;
    }
    answer = next;
  }
  return answer;
}

/** Shared helpers keep renderer output identical to reviewed artifact values. */
export const finalAnswerFormat = {
  number(value: number | null | undefined): string {
    return value === null || value === undefined
      ? 'unavailable'
      : String(value);
  },
  ref(ref: ArtifactRef): string {
    return `${ref.id} v${ref.version} (${ref.sha256.slice(0, 12)})`;
  },
  review(
    reviews: readonly ArtifactReviewCheck[],
    artifact: ArtifactRef,
  ): ArtifactReviewCheck | undefined {
    return reviews.find(
      (check) =>
        check.artifact.id === artifact.id &&
        check.artifact.version === artifact.version &&
        check.artifact.sha256 === artifact.sha256,
    );
  },
};
