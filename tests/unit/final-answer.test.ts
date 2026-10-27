import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';
import type { Artifact, ArtifactRef } from '../../app/contracts/artifacts.js';
import type { ArtifactReviewCheck } from '../../app/contracts/manager.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import type {
  ReductionClaimEligibility,
  PhysicalResidualImport,
} from '../../app/contracts/damage-reduction.js';
import { contractHash } from '../../app/contracts/json.js';
import type {
  FinalRendererInput,
  StatefulToolStore,
} from '../../app/orchestration/ports.js';
import { roundedPercent } from '../../app/orchestration/final-answer.js';
import { pm25AnalysisSchema } from '../../app/capabilities/pm25/methods.js';
import { damageAccountFinalRenderer } from '../../app/capabilities/damage-appraisal/final-answer.js';
import { createReductionFinalRenderer } from '../../app/capabilities/damage-reduction-planning/final-answer.js';
import { normalizeDamageInputs } from '../../app/capabilities/damage-appraisal/inputs.js';
import {
  assembleDamageAccount,
  compileDamageAccount,
  DAMAGE_COMPONENT_KINDS,
} from '../../app/capabilities/damage-appraisal/methods.js';
import {
  createSyntheticDamageArtifact,
  SYNTHETIC_DAMAGE_EXPECTATIONS,
} from '../../app/capabilities/damage-appraisal/fixtures.js';
import {
  syntheticResidualImport,
  SYNTHETIC_REDUCTION_TARGET,
} from '../../app/capabilities/damage-reduction-planning/fixtures.js';
import {
  createReductionSelection,
  exactReductionRef,
} from '../../app/capabilities/damage-reduction-planning/inputs.js';
import { assessReduction } from '../../app/capabilities/damage-reduction-planning/methods.js';
import { scriptedAgentModel } from './scripted-model.js';

const INVENTED = '987.654';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ref = (artifact: Artifact): ArtifactRef => ({
  id: artifact.id,
  version: artifact.version,
  sha256: artifact.sha256,
});
function stored(
  kind: string,
  content: unknown,
  dependencies: ArtifactRef[] = [],
): Artifact {
  return {
    schema_version: 'haze.artifact.v3',
    id: randomUUID(),
    version: 1,
    sha256: contractHash(content),
    identity: { principal: 'test', workspace: 'test' },
    assignment_id: randomUUID(),
    kind,
    producer: { kind: 'service', id: 'test' },
    created_at: '2026-10-27T00:00:00Z',
    dependencies,
    required_tools: [],
    content: content as Artifact['content'],
  };
}
function supported(artifact: Artifact, review = stored('review', {})) {
  return {
    artifact: ref(artifact),
    producer_assignment_id: randomUUID(),
    producer_revision: 1,
    reviewer_assignment_id: randomUUID(),
    reviewer_revision: 1,
    verdict: 'supported',
    review_artifact: ref(review),
    limitations: ['Reviewer limitation retained.'],
  } satisfies ArtifactReviewCheck;
}
function input(
  artifacts: Artifact[],
  closure: Artifact[],
  reviews: ArtifactReviewCheck[],
): FinalRendererInput {
  return {
    task: {
      id: randomUUID(),
      identity: localTaskIdentity,
      current_run_id: randomUUID(),
    } as TaskRecord,
    artifacts,
    closure,
    reviews,
    services: {
      store: {} as StatefulToolStore,
      mode: 'fixture',
      read: (value) => closure.find((item) => item.id === value.id)!,
    },
  };
}
const text = (rendered: { sections: { heading: string; lines: string[] }[] }) =>
  rendered.sections
    .map((section) => [section.heading, ...section.lines].join('\n'))
    .join('\n');

describe('grounded final answers', () => {
  it('never saves a number the Manager invented while citing valid evidence', async () => {
    const registry = createExecutionRegistry({ mode: 'fixture' });
    const manager = registry.agents.get('Manager')!;
    // The scripted Manager keeps valid exact citations but invents a figure.
    registry.agents.set('Manager', {
      ...manager,
      fixtureDecision(context) {
        const decision = manager.fixtureDecision!(context);
        if (decision.action.type === 'finalize')
          decision.action.answer = `PM2.5 peaked at ${INVENTED} µg/m³ with full coverage ${decision.action.answer}`;
        return decision;
      },
    });
    const directory = await mkdtemp(join(tmpdir(), 'haze-final-answer-'));
    const runtime = new TaskRuntime({
      stateDirectory: directory,
      registry,
      mode: 'fixture',
      model: scriptedAgentModel(),
    });
    cleanups.push(async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    });
    const admitted = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective:
          'Investigate PM2.5 for Kuala Lumpur during 2026-10-01T00:00:00Z to 2026-10-01T03:00:00Z.',
        scope: {
          location: 'Kuala Lumpur',
          period: {
            start: '2026-10-01T00:00:00Z',
            end: '2026-10-01T03:00:00Z',
          },
        },
      },
      'invented-number',
    );
    const deadline = Date.now() + 25_000;
    let task = runtime.store.read(admitted.task_id, localTaskIdentity);
    while (
      !['completed', 'failed', 'waiting', 'paused'].includes(task.status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      task = runtime.store.read(admitted.task_id, localTaskIdentity);
    }
    expect(task.status, task.error?.message).toBe('completed');
    const answer = task.result!.answer;
    expect(answer).not.toContain(INVENTED);
    const analysis = task.result!.work_products
      .map((item) => runtime.store.artifact(item.id, localTaskIdentity))
      .find((artifact) => artifact.kind === 'pm25.analysis')!;
    const reviewed = pm25AnalysisSchema.parse(analysis.content);
    expect(answer).toContain(
      `${reviewed.coverage.usable_row_count} usable of ${reviewed.coverage.row_count}`,
    );
    expect(answer).toContain(
      `Range: ${reviewed.range.min} to ${reviewed.range.max} µg/m³`,
    );
    expect(answer).toContain('Kuala Lumpur');
    expect(answer).toContain('[E1]');
    const event = runtime.store
      .events(task.id, localTaskIdentity)
      .events.find((item) => item.type === 'final_answer_rendered');
    expect(event?.data).toMatchObject({
      capabilities: ['pm25-evidence-summary'],
    });
    // The Manager's own prose remains auditable, outside the factual answer.
    const audit = runtime.store.db
      .prepare('SELECT body FROM manager_decisions WHERE task_id=?')
      .all(task.id) as { body: string }[];
    expect(audit.some((row) => row.body.includes(INVENTED))).toBe(true);
  }, 30_000);

  it('renders damage accounts by endpoint and keeps financial and welfare totals apart', () => {
    const inputs = normalizeDamageInputs([createSyntheticDamageArtifact()]);
    const components = compileDamageAccount(inputs);
    const refs = Object.fromEntries(
      DAMAGE_COMPONENT_KINDS.map((kind) => [
        kind,
        { id: randomUUID(), version: 1, sha256: contractHash(components[kind]) },
      ]),
    ) as Parameters<typeof assembleDamageAccount>[2];
    const account = stored(
      'damage.account',
      assembleDamageAccount(inputs, components, refs),
    );
    const rendered = damageAccountFinalRenderer.render(
      input([account], [account], [supported(account)]),
    );
    const output = text(rendered);
    expect(output).toContain(
      `historical — mortality: ${SYNTHETIC_DAMAGE_EXPECTATIONS.deaths} expected_deaths`,
    );
    const physical = rendered.sections.find((s) =>
      s.heading.endsWith('physical outcomes by endpoint and unit'),
    )!;
    // No line mixes endpoints or units into one physical sum.
    expect(physical.lines.every((line) => line.split(' — ').length === 2)).toBe(
      true,
    );
    const financial = rendered.sections.find((s) =>
      s.heading.endsWith('financial incidence totals'),
    )!;
    const welfare = rendered.sections.find((s) =>
      s.heading.endsWith('selected social-welfare totals'),
    )!;
    expect(financial.lines[0]).toMatch(/400000 CU \(\d{4} prices\)/u);
    expect(welfare.lines[0]).toContain(
      String(components['damage.welfare'].totals[0]!.amount),
    );
    expect(welfare.lines.join()).not.toBe(financial.lines.join());
    expect(output).toContain('synthetic, not a real-data result');
    expect(output).toMatch(/Currency CU; price year \d{4}/u);
    expect(rendered.limitations).toContain('Reviewer limitation retained.');
  });
});

describe('reduction final renderer', () => {
  const claim = (
    eligibility: ReductionClaimEligibility['claim_eligibility'],
    reasons: string[] = [],
  ) =>
    (() => ({
      claim_eligibility: eligibility,
      point_estimate_label: 'unavailable',
      origin: 'synthetic',
      scientific_qualification: 'unqualified',
      achieved_reduction: false,
      reasons,
    })) as unknown as Parameters<typeof createReductionFinalRenderer>[0];
  function render(
    residuals: PhysicalResidualImport,
    eligibility: ReductionClaimEligibility['claim_eligibility'] = 'arithmetic_checked_scenario',
    reasons: string[] = [],
  ) {
    const source = stored('artifact.import', residuals);
    const selection = stored(
      'reduction.input-selection',
      createReductionSelection(structuredClone(SYNTHETIC_REDUCTION_TARGET), [
        {
          artifact: exactReductionRef(source),
          row_ids: residuals.records.map((record) => record.row_id),
        },
      ]),
    );
    const assessment = stored(
      'reduction.assessment',
      assessReduction(
        selection.content as Parameters<typeof assessReduction>[0],
        [source],
        ref(selection),
      ),
      [ref(selection)],
    );
    const rendered = createReductionFinalRenderer(
      claim(eligibility, reasons),
    ).render(
      input(
        [assessment],
        [source, selection, assessment],
        [supported(assessment)],
      ),
    );
    return { rendered, output: text(rendered) };
  }

  it('reports a met threshold with exact classification and labelled rounding', () => {
    const { rendered, output } = render(syntheticResidualImport('1000', '880'));
    expect(output).toContain('Baseline');
    expect(output).toContain('1000 person-days');
    expect(output).toContain('880 person-days');
    expect(output).toContain('Avoided damage: 120 person-days');
    expect(output).toContain('Reduction: 12.000%');
    expect(output).toContain('rounded half-up to three decimal places');
    expect(output).toContain('at least 10.000% — point estimate meets');
    expect(rendered.gaps).toEqual([]);
  });
  it('reports a below-threshold result without rounding it across the target', () => {
    const { output } = render(
      syntheticResidualImport('1000', '900.000000000001'),
    );
    // 9.9999999999999% displays as 10.000% but is classified exactly below.
    expect(output).toContain('Reduction: 10.000%');
    expect(output).toContain('does not meet the target');
  });
  it('reports a zero baseline as an explicit gap', () => {
    const { rendered, output } = render(syntheticResidualImport('0', '0'));
    expect(output).not.toContain('Reduction:');
    expect(rendered.gaps.length).toBeGreaterThan(0);
  });
  it('reports incompatible scope as an explicit gap', () => {
    const residuals = syntheticResidualImport('1000', '880');
    residuals.records[1]!.scope.unit = 'incompatible-unit';
    const { rendered, output } = render(residuals);
    expect(output).not.toContain('Reduction:');
    expect(rendered.gaps.join()).toMatch(/incompatible|gap/u);
  });
  it('withholds figures when current support has changed', () => {
    const { rendered, output } = render(
      syntheticResidualImport('1000', '880'),
      'none',
      ['claim_current_operator_selection_changed'],
    );
    expect(output).not.toContain('Reduction:');
    expect(rendered.gaps.join()).toContain(
      'claim_current_operator_selection_changed',
    );
  });
});

describe('roundedPercent', () => {
  it.each([
    [1n, 3n, '33.333'],
    [2n, 3n, '66.667'],
    [1n, 8n, '12.500'],
    [99999999999999n, 1000000000000000n, '10.000'],
    [-1n, 8n, '-12.500'],
  ])('%s/%s → %s', (numerator, denominator, expected) => {
    expect(roundedPercent(numerator, denominator)).toBe(expected);
  });
});
