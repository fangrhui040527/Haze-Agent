import type { FinalRenderer } from '../../orchestration/ports.js';
import { finalAnswerFormat as format } from '../../orchestration/final-answer.js';
import { captureSchema, pm25AnalysisSchema } from './methods.js';

const MISSING_INTERVALS_SHOWN = 12;

/** Every figure is copied from the reviewed analysis or its exact capture. */
export const pm25FinalRenderer: FinalRenderer = {
  artifact_kinds: ['pm25.analysis'],
  render({ artifacts, closure, reviews }) {
    const sections: ReturnType<FinalRenderer['render']>['sections'] = [];
    const limitations: string[] = [];
    const gaps: string[] = [];
    for (const artifact of artifacts) {
      const analysis = pm25AnalysisSchema.parse(artifact.content);
      const captureArtifact = closure.find(
        (item) =>
          item.kind === 'pm25.capture' &&
          artifact.dependencies.some(
            (ref) =>
              ref.id === item.id &&
              ref.version === item.version &&
              ref.sha256 === item.sha256,
          ),
      );
      const capture = captureArtifact
        ? captureSchema.parse(captureArtifact.content)
        : undefined;
      const review = format.review(reviews, artifact);
      const { coverage, range, scope } = analysis;
      const units = capture?.units ?? 'µg/m³';
      const classification = [
        `${coverage.modeled_count} modeled`,
        `${coverage.observation_count} observed`,
        `${coverage.unknown_kind_count} unknown-kind`,
      ].join(', ');
      const synthetic =
        capture?.mode === 'fixture' ||
        capture?.evidence_origin === 'synthetic_fixture';
      const missing = coverage.missing_intervals;
      sections.push({
        heading: `PM2.5 evidence: ${scope.location}`,
        lines: [
          `Scope: ${scope.location}, ${scope.period.start} to ${scope.period.end} (UTC, end exclusive).`,
          `Evidence classification: ${classification} samples${capture ? `; source ${capture.source}, ${capture.temporal_support} ${capture.sample_interval_minutes}-minute modeled samples` : ''}${synthetic ? '; synthetic fixture, not real-world evidence' : ''}.`,
          `Coverage: ${coverage.status}; ${coverage.usable_row_count} usable of ${coverage.row_count} retained samples.`,
          missing.length
            ? `Missing intervals: ${missing.length} (${missing
                .slice(0, MISSING_INTERVALS_SHOWN)
                .map((interval) => `${interval.start} to ${interval.end}`)
                .join(
                  '; ',
                )}${missing.length > MISSING_INTERVALS_SHOWN ? `; ${missing.length - MISSING_INTERVALS_SHOWN} more retained in the analysis` : ''}).`
            : 'Missing intervals: none within the requested period.',
          range.min === null || range.max === null
            ? 'Range: unavailable; no usable samples.'
            : `Range: ${format.number(range.min)} to ${format.number(range.max)} ${units}.`,
          `Independent numerical check: ${review?.verdict ?? 'not recorded'}; analysis ${format.ref(artifact)}.`,
        ],
      });
      if (coverage.status !== 'available')
        gaps.push(
          `PM2.5 coverage for ${scope.location} is ${coverage.status}; the period is not fully represented.`,
        );
      limitations.push(
        ...analysis.unresolved_gaps,
        ...analysis.assumptions,
        ...(capture?.limitations ?? []),
        ...(review?.limitations ?? []),
        'Modeled concentrations are not observations; no causal attribution, health advice or operational decision is supported.',
      );
    }
    return { sections, limitations, gaps };
  },
};
