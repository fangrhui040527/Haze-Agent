import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionRegistry } from '../../app/composition.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import type { Artifact, ArtifactRef } from '../../app/contracts/artifacts.js';
import { contractHash } from '../../app/contracts/json.js';
import {
  damageAccountComponentSchema,
  damageAccountManifestSchema,
  damageAccountScopeSchema,
} from '../../app/capabilities/damage-account-intake/contracts.js';
import { synthesisReviewSchema } from '../../app/capabilities/evidence-synthesis/contracts.js';
import { episodeReviewSchema } from '../../app/capabilities/episode-investigation/contracts.js';
import { assessArtifactReviews } from '../../app/orchestration/runtime.js';
import { TaskRuntime, localTaskIdentity } from '../../app/tasks/runtime.js';

const instances: { runtime: TaskRuntime; directory: string }[] = [];
afterEach(async () => {
  for (const { runtime, directory } of instances.splice(0)) {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function createRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'haze-capability-merge-'));
  const registry = createExecutionRegistry({ mode: 'fixture' });
  const runtime = new TaskRuntime({
    stateDirectory: directory,
    registry,
    mode: 'fixture',
  });
  instances.push({ runtime, directory });
  return { runtime, registry };
}

async function completed(runtime: TaskRuntime, id: string) {
  const terminal = ['completed', 'failed', 'waiting', 'paused', 'timed_out'];
  await expect
    .poll(() => runtime.store.read(id, localTaskIdentity).status, {
      timeout: 8000,
      interval: 10,
    })
    .toSatisfy((status: string) => terminal.includes(status));
  const task = runtime.store.read(id, localTaskIdentity);
  expect(task.status, task.error?.message).toBe('completed');
  return task;
}

const ref = ({ id, version, sha256 }: Artifact): ArtifactRef => ({
  id,
  version,
  sha256,
});
const artifactsFor = (runtime: TaskRuntime, task: TaskRecord) =>
  task.artifacts.map(({ artifact }) =>
    runtime.store.artifact(artifact.id, localTaskIdentity, artifact),
  );
const coordinatedPurposes = (task: TaskRecord) =>
  task.manager?.decisions.flatMap(({ decision }) =>
    decision.action.type === 'coordinate' ? [decision.action.purpose] : [],
  );

describe('merged capability review integration', () => {
  it('retains supplied manifest accounting when its typed scope distinguishes it from calculated accounting', async () => {
    const { runtime, registry } = await createRuntime();
    const scope = damageAccountScopeSchema.parse({
      account_id: 'klang-physical-account',
      account_type: 'physical_outcomes',
      episode_id: 'episode-2026-10',
      geography: { id: 'klang', label: 'Klang', level: 'district' },
      period: {
        start: '2026-10-01T00:00:00Z',
        end: '2026-10-02T00:00:00Z',
      },
      counterfactual_id: 'declared-comparator',
    });
    const component = runtime.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'component.json',
        media_type: 'application/json',
        content_base64: Buffer.from(
          JSON.stringify(
            damageAccountComponentSchema.parse({
              schema_version: 'haze.damage.component.v1',
              account_id: scope.account_id,
              component_id: 'physical-count',
              revision: 1,
              scope_sha256: contractHash(scope),
              category: 'physical_outcome',
              measure: { value: 12, unit: 'cases' },
              evidence: [],
              included_in_total: false,
              limitations: ['Synthetic fixture only.'],
            }),
          ),
        ).toString('base64'),
      },
      'manifest-component',
    );
    const manifest = runtime.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'manifest.json',
        media_type: 'application/json',
        content_base64: Buffer.from(
          JSON.stringify(
            damageAccountManifestSchema.parse({
              schema_version: 'haze.damage.account-manifest.v1',
              scope,
              revision: 1,
              required_component_ids: ['physical-count'],
              components: [
                {
                  component_id: 'physical-count',
                  revision: 1,
                  artifact: ref(component),
                },
              ],
            }),
          ),
        ).toString('base64'),
      },
      'manifest',
    );
    const admitted = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective:
          'Build a damage account from the supplied manifest and components.',
        scope,
        context_refs: [ref(component), ref(manifest)],
      },
      'manifest-task',
    );
    const task = await completed(runtime, admitted.task_id);
    expect(
      task.assignments
        .filter((assignment) => assignment.role !== 'Manager')
        .map((assignment) => assignment.definition_id),
    ).toEqual(['damage-accounting.intake']);
    expect(
      artifactsFor(runtime, task).find(
        (artifact) => artifact.kind === 'damage-accounting.intake',
      )?.content,
    ).toMatchObject({
      manifest: ref(manifest),
      status: 'components_present',
      resolved_component_ids: ['physical-count'],
      missing_component_ids: [],
    });
    expect(
      runtime.store.world
        .lookup({ ...localTaskIdentity, mode: 'fixture' }, { limit: 50 })
        .map((record) => record.kind),
    ).toEqual(
      expect.arrayContaining([
        'damage_account_reference',
        'damage_component_reference',
      ]),
    );
    const unscoped = { ...task.original_request };
    delete unscoped.scope;
    expect(
      registry.capabilities
        .get('damage-appraisal')
        ?.matches(task.original_request),
    ).toBe(false);
    expect(
      registry.capabilities
        .get('damage-account-intake')
        ?.matches(task.original_request),
    ).toBe(true);
    expect(
      registry.capabilities.get('damage-appraisal')?.matches(unscoped),
    ).toBe(true);
  });

  it('coordinates source review and preserves exact manager and World Model coverage for PM2.5 report explanations', async () => {
    const { runtime, registry } = await createRuntime();
    const source = runtime.importArtifact(
      {
        schema_version: 'haze.artifact.import.v3',
        filename: 'haze-report.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from(
          'This supplied PM2.5 report describes modeled haze evidence; observations are unavailable.',
        ).toString('base64'),
      },
      'source',
    );
    const admitted = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Explain the supplied PM2.5 haze report.',
        context_refs: [ref(source)],
      },
      'synthesis',
    );
    const task = await completed(runtime, admitted.task_id);
    expect(
      task.assignments
        .filter((assignment) => assignment.role !== 'Manager')
        .map((assignment) => assignment.definition_id),
    ).toEqual(['evidence-synthesis.extract', 'evidence-synthesis.review']);
    expect(coordinatedPurposes(task)).toContain('synthesis-review');

    const artifacts = artifactsFor(runtime, task);
    const notes = artifacts.find(
      (artifact) => artifact.kind === 'evidence-synthesis.notes',
    )!;
    const review = artifacts.find(
      (artifact) => artifact.kind === 'evidence-synthesis.review',
    )!;
    const typedReview = synthesisReviewSchema.parse(review.content);
    expect(typedReview.notes).toEqual(ref(notes));
    expect(typedReview.reviewed_sources).toContainEqual(ref(source));
    expect(assessArtifactReviews(task, registry, artifacts)).toContainEqual(
      expect.objectContaining({ artifact: ref(notes), verdict: 'supported' }),
    );
    expect(
      runtime.store.world
        .lookup({ ...localTaskIdentity, mode: 'fixture' }, { limit: 50 })
        .map((record) => record.kind),
    ).toContain('evidence_synthesis_review');

    const staleReviewer = structuredClone(task);
    const reviewer = staleReviewer.assignments.find(
      (assignment) => assignment.definition_id === 'evidence-synthesis.review',
    )!;
    reviewer.inputs = reviewer.inputs.map((input) =>
      input.id === notes.id ? { ...input, version: input.version + 1 } : input,
    );
    expect(
      assessArtifactReviews(staleReviewer, registry, artifacts),
    ).toContainEqual(
      expect.objectContaining({
        artifact: ref(notes),
        verdict: 'needs_review',
      }),
    );
  });

  it('coordinates exact episode review while preserving unresolved evidence branches', async () => {
    const { runtime } = await createRuntime();
    const admitted = runtime.admit(
      {
        schema_version: 'haze.task.request.v3',
        objective: 'Investigate the October haze episode.',
        scope: {
          episode_id: 'episode-2026-10',
          label: 'October haze episode',
          geography: { id: 'klang', label: 'Klang' },
          period: {
            start: '2026-10-01T00:00:00Z',
            end: '2026-10-02T00:00:00Z',
          },
        },
      },
      'episode',
    );
    const task = await completed(runtime, admitted.task_id);
    expect(coordinatedPurposes(task)).toContain('episode-review');
    const artifacts = artifactsFor(runtime, task);
    const context = artifacts.find(
      (artifact) => artifact.kind === 'episode-investigation.context',
    )!;
    const gaps = artifacts.find(
      (artifact) => artifact.kind === 'episode-investigation.evidence-gaps',
    )!;
    const review = artifacts.find(
      (artifact) => artifact.kind === 'episode-investigation.review',
    )!;
    const typedReview = episodeReviewSchema.parse(review.content);
    expect(typedReview.context).toEqual(ref(context));
    expect(typedReview.gap_report).toEqual(ref(gaps));
    expect(typedReview.status).toBe('partial');
    expect(typedReview.reviewed_branches).toEqual([
      {
        id: 'observations',
        source_availability: 'not_configured',
        status: 'unresolved',
      },
      {
        id: 'attribution',
        source_availability: 'not_configured',
        status: 'unresolved',
      },
    ]);
    expect(task.result?.completion).toBe('partial');
  });
});
