import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { managerAgent } from '../../app/agents/manager/index.js';
import type { Artifact, ArtifactRef } from '../../app/contracts/artifacts.js';
import type {
  ManagerAction,
  ManagerContext,
} from '../../app/contracts/manager.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import { ExecutionRegistry } from '../../app/orchestration/ports.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';

const reference = ({ id, version, sha256 }: Artifact): ArtifactRef => ({
  id,
  version,
  sha256,
});

async function completed(runtime: TaskRuntime, id: string) {
  const deadline = Date.now() + 5000;
  let task: TaskRecord;
  do {
    task = runtime.store.read(id, localTaskIdentity);
    if (['completed', 'failed', 'paused'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(JSON.stringify(task));
}

it('projects and accepts only the Manager final selection and its exact supporting review', async () => {
  const registry = new ExecutionRegistry()
    .registerAgent(managerAgent)
    .registerAgent({
      id: 'HazeOps',
      version: '1',
      instructions: 'Produce work.',
    })
    .registerAgent({
      id: 'EvidenceCritic',
      version: '1',
      instructions: 'Independently review exact work.',
    })
    .registerCapability({
      card: {
        id: 'pm25-evidence-summary',
        version: 'merge-test.v1',
        purpose: 'Exercise final selection and World acceptance together.',
        work_products: ['merge.finding'],
        required_tools: [],
        roles: ['HazeOps', 'EvidenceCritic'],
        readiness: 'implemented',
        limitations: [],
      },
      matches: () => true,
      assignments: () => [],
      review_requirements: [
        {
          artifact_kind: 'merge.finding',
          review_definition_id: 'merge.review',
        },
      ],
      normalizeReview: (artifact) => {
        if (artifact.kind !== 'merge.review') return undefined;
        const review = artifact.content as {
          finding: ArtifactRef;
          verdict: 'supported' | 'rejected';
        };
        return {
          verdict: review.verdict,
          artifacts: [review.finding],
          limitations: [],
        };
      },
      worldModel: {
        extract: ({ artifacts }) =>
          artifacts
            .filter((artifact) =>
              ['merge.finding', 'merge.review'].includes(artifact.kind),
            )
            .map((artifact) => ({
              kind: artifact.kind,
              external_id: artifact.id,
              payload: artifact.content,
              evidence: [reference(artifact)],
            })),
        buildAcceptanceCandidate: ({ records, artifacts }) => {
          const finding = records.find(
            (record) => record.kind === 'merge.finding',
          );
          const review = artifacts.find(
            (artifact) => artifact.kind === 'merge.review',
          );
          if (!finding || !review) return undefined;
          return {
            subject: finding.ref,
            stated_use: 'pm25-evidence-summary',
            evidence: [reference(review)],
          };
        },
        requiredReviewCoverage: ({ artifacts }) =>
          artifacts
            .filter((artifact) => artifact.kind === 'merge.finding')
            .map((artifact) => ({
              id: `review:${artifact.id}`,
              evidence: [reference(artifact)],
              reviewer_roles: ['EvidenceCritic' as const],
            })),
      },
    })
    .registerAssignment({
      id: 'merge.produce',
      version: '1',
      capability: 'pm25-evidence-summary',
      agent: 'HazeOps',
      tools: [],
      instructions: 'Produce one finding.',
      execute(services) {
        const artifact = services.save('merge.finding', services.input);
        return {
          status: 'completed',
          summary: 'Finding is ready for independent review.',
          support: 'supported',
          uncertainty: [],
          outputs: [artifact],
        };
      },
    })
    .registerAssignment({
      id: 'merge.review',
      version: '1',
      capability: 'pm25-evidence-summary',
      agent: 'EvidenceCritic',
      tools: [],
      instructions: 'Review the pinned finding.',
      execute(services) {
        const finding = services.context.inputs.find(
          (artifact) => artifact.kind === 'merge.finding',
        )!;
        const verdict =
          finding.content === 'retained' ? 'supported' : 'rejected';
        const review = services.save('merge.review', {
          finding: reference(finding),
          verdict,
        });
        return {
          status: 'completed',
          summary: 'Exact finding independently checked.',
          support: 'supported',
          uncertainty: [],
          outputs: [review],
        };
      },
    });
  const directory = await mkdtemp(join(tmpdir(), 'haze-merge-world-'));
  const runtime: TaskRuntime = new TaskRuntime({
    stateDirectory: directory,
    registry,
    mode: 'live',
    acceptancePolicy: 'research-v1',
    model: {
      selection: { provider: 'scripted', model: 'merge-world-regression' },
      complete(input) {
        const context = input.context as ManagerContext;
        const workers = context.assignments.filter(
          (assignment) =>
            assignment.definition_id !== 'core.manager.coordinator',
        );
        let action: ManagerAction;
        if (!workers.length) {
          action = {
            type: 'apply_plan',
            assignments: ['retained', 'excluded'].flatMap((label) => [
              {
                key: label,
                definition_id: 'merge.produce',
                brief: `Produce the ${label} finding.`,
                depends_on: [],
                input: label,
              },
              {
                key: `${label}-review`,
                definition_id: 'merge.review',
                brief: `Independently review the ${label} finding.`,
                depends_on: [label],
              },
            ]),
            retain_assignment_ids: [],
            reason: 'Admit both branches with independent reviews.',
          };
        } else if (workers.every((worker) => worker.status === 'completed')) {
          const retained = context.artifacts.find((artifact) => {
            if (artifact.kind !== 'merge.finding') return false;
            return (
              runtime.store.artifact(artifact.ref.id, localTaskIdentity)
                .content === 'retained'
            );
          })!;
          action = {
            type: 'finalize',
            answer: 'Only the retained finding is supported.',
            work_products: [retained.ref],
            sources: [],
            uncertainty: [],
            unfinished: [],
          };
        } else {
          action = { type: 'wait', reason: 'Await the independent reviews.' };
        }
        return Promise.resolve(
          JSON.stringify({
            id: randomUUID(),
            run_id: context.run_id,
            generation: context.generation,
            objective_revision: context.objective_revision,
            plan_revision: context.plan_revision,
            event_cursor: context.event_cursor,
            explanation:
              'Retain only reviewed evidence in the final selection.',
            references: [],
            ...(!context.interpretation
              ? {
                  interpretation: {
                    scope: context.request.objective,
                    deliverables: ['A reviewed finding.'],
                    assumptions: [],
                    intended_use: 'Verify merge integration.',
                    stopping_conditions: ['Retain supported work.'],
                  },
                }
              : {}),
            action,
          }),
        );
      },
    },
  });
  try {
    const { task_id: id } = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Compare two findings and retain only supported work.',
      },
      randomUUID(),
    );
    const task = await completed(runtime, id);
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(task.result?.completion).toBe('partial');
    expect(task.result?.review.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ verdict: 'supported' }),
        expect.objectContaining({ verdict: 'rejected' }),
      ]),
    );
    const events = runtime.store.world.events({
      ...localTaskIdentity,
      mode: 'live',
    });
    const projections = events.flatMap((event) =>
      event.event_kind === 'record_created' &&
      ['merge.finding', 'merge.review'].includes(event.value.kind)
        ? [event.value]
        : [],
    );
    expect(projections).toHaveLength(2);
    expect(
      projections.find((record) => record.kind === 'merge.finding'),
    ).toMatchObject({ payload: 'retained' });
    expect(
      projections.find((record) => record.kind === 'merge.review'),
    ).toMatchObject({ payload: { verdict: 'supported' } });
    const acceptances = events.flatMap((event) =>
      event.event_kind === 'acceptance_evaluated' ? [event.value] : [],
    );
    expect(acceptances).toHaveLength(1);
    expect(acceptances[0]).toMatchObject({
      status: 'accepted',
      subject: projections.find((record) => record.kind === 'merge.finding')!
        .ref,
    });
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
