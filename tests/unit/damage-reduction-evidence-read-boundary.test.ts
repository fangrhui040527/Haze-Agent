import { describe, expect, it, vi } from 'vitest';
import type { Artifact, ArtifactRef } from '../../app/contracts/artifacts.js';
import type { ArtifactReviewCheck } from '../../app/contracts/manager.js';
import type { TaskRecord } from '../../app/contracts/tasks.js';
import { contractHash } from '../../app/contracts/json.js';
import { createProgrammeEvidenceReadBoundary } from '../../app/capabilities/damage-reduction-programmes/index.js';

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const identity = {
  principal: 'read-boundary-test',
  workspace: 'read-boundary-test',
};
const ref = ({ id, version, sha256 }: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
type Host = Parameters<typeof createProgrammeEvidenceReadBoundary>[0];

function setup() {
  const artifacts = new Map<string, Artifact>(),
    owners = new Map<string, TaskRecord>();
  const held = new Set<string>(),
    reviews: ArtifactReviewCheck[] = [];
  const artifact = (
    value: number,
    dependencies: ArtifactRef[] = [],
  ): Artifact => {
    const content = { description: `Exact source ${value}` };
    const valueArtifact: Artifact = {
      schema_version: 'haze.artifact.v3',
      id: id(value),
      version: 1,
      sha256: contractHash(content),
      identity,
      kind: 'source.import',
      producer: { kind: 'user', id: identity.principal },
      created_at: '2026-10-27T00:00:00Z',
      dependencies,
      required_tools: [],
      content,
    };
    artifacts.set(valueArtifact.id, valueArtifact);
    return valueArtifact;
  };
  const readArtifact = vi.fn<Host['readArtifact']>(
    (selected, requestedIdentity) => {
      if (
        requestedIdentity.principal !== identity.principal ||
        requestedIdentity.workspace !== identity.workspace
      )
        throw new Error('Identity denied.');
      const value = artifacts.get(selected.id);
      if (!value) throw new Error('Exact source unavailable.');
      return value;
    },
  );
  const readTask = vi.fn<Host['readTask']>((taskId) => {
    const value = owners.get(taskId);
    if (!value) throw new Error('Owner unavailable.');
    return value;
  });
  const artifactReviews = vi.fn<Host['artifactReviews']>(() => reviews);
  const lookup = vi.fn<Host['store']['world']['lookup']>((_scope, query) => {
    if (held.has(query.external_id?.split(':')[1] ?? ''))
      throw new Error('Source held.');
    return [];
  });
  const host: Host = {
    mode: 'fixture',
    readArtifact,
    readTask,
    artifactReviews,
    store: { world: { lookup, activeHolds: () => [] } },
  };
  return {
    boundary: createProgrammeEvidenceReadBoundary(host),
    artifact,
    artifacts,
    owners,
    held,
    reviews,
    readArtifact,
    readTask,
    artifactReviews,
    lookup,
  };
}

describe('synchronous programme evidence read boundary', () => {
  it('reuses nested read work but rechecks holds and identity on later independent operations', () => {
    const fixture = setup(),
      source = fixture.artifact(1);
    fixture.boundary.withEvidenceRead(() => {
      fixture.boundary.assertEvidenceCurrent(source, identity);
      fixture.boundary.withEvidenceRead(() =>
        fixture.boundary.assertEvidenceCurrent(source, identity),
      );
      expect(fixture.readArtifact).toHaveBeenCalledTimes(1);
      expect(fixture.lookup).toHaveBeenCalledTimes(1);
      expect(() =>
        fixture.boundary.assertEvidenceCurrent(source, {
          ...identity,
          principal: 'different-principal',
        }),
      ).toThrow('Identity denied');
    });
    fixture.held.add(source.id);
    expect(() =>
      fixture.boundary.withEvidenceRead(() =>
        fixture.boundary.assertEvidenceCurrent(source, identity),
      ),
    ).toThrow('Source held');
    fixture.held.clear();
    expect(() =>
      fixture.boundary.withEvidenceRead(() =>
        fixture.boundary.assertEvidenceCurrent(source, identity),
      ),
    ).not.toThrow();
    expect(fixture.readArtifact).toHaveBeenCalledTimes(4);
  });

  it('does not reuse a product temporarily checked before a failed independent review', () => {
    const fixture = setup(),
      product = fixture.artifact(1),
      review = fixture.artifact(2);
    const ownerId = id(3),
      producerId = id(4),
      reviewerId = id(5),
      runId = id(6);
    product.task_id = ownerId;
    product.run_id = runId;
    product.objective_revision = 1;
    product.assignment_id = producerId;
    product.assignment_revision = 1;
    product.producer = { kind: 'assignment', id: producerId };
    // Only the checker-owned task boundary fields are mocked; no task execution
    // or scientific qualification is asserted by this performance regression.
    fixture.owners.set(ownerId, {
      id: ownerId,
      mode: 'fixture',
      current_run_id: runId,
      objective_revision: 1,
      permissions: { tools: [], effects: [] },
      artifacts: [
        { current: true, objective_revision: 1, artifact: ref(product) },
      ],
      assignments: [
        {
          id: producerId,
          run_id: runId,
          objective_revision: 1,
          revision: 1,
          status: 'completed',
          usability: 'usable',
          outputs: [ref(product)],
        },
      ],
    } as unknown as TaskRecord);
    fixture.reviews.push({
      artifact: ref(product),
      producer_assignment_id: producerId,
      producer_revision: 1,
      reviewer_assignment_id: reviewerId,
      reviewer_revision: 1,
      verdict: 'supported',
      review_artifact: ref(review),
      limitations: [],
    });
    fixture.held.add(review.id);
    fixture.boundary.withEvidenceRead(() => {
      expect(() =>
        fixture.boundary.assertEvidenceCurrent(product, identity),
      ).toThrow('Source held');
      expect(() =>
        fixture.boundary.assertEvidenceCurrent(product, identity),
      ).toThrow('Source held');
      expect(fixture.lookup).toHaveBeenCalledTimes(4);
      expect(fixture.readTask).toHaveBeenCalledTimes(1);
      expect(fixture.artifactReviews).toHaveBeenCalledTimes(1);
    });
    fixture.held.clear();
    expect(() =>
      fixture.boundary.withEvidenceRead(() =>
        fixture.boundary.assertEvidenceCurrent(product, identity),
      ),
    ).not.toThrow();
    expect(fixture.artifactReviews).toHaveBeenCalledTimes(2);
  });

  it('keeps the closure bound per root even when earlier roots are cached', () => {
    const fixture = setup();
    const leftLeaves = Array.from({ length: 200 }, (_, index) =>
      fixture.artifact(index + 1),
    );
    const rightLeaves = Array.from({ length: 60 }, (_, index) =>
      fixture.artifact(index + 300),
    );
    const left = fixture.artifact(700, leftLeaves.map(ref)),
      right = fixture.artifact(701, rightLeaves.map(ref));
    const oversized = fixture.artifact(702, [ref(left), ref(right)]);
    fixture.boundary.withEvidenceRead(() => {
      expect(() =>
        fixture.boundary.assertEvidenceCurrent(left, identity),
      ).not.toThrow();
      expect(() =>
        fixture.boundary.assertEvidenceCurrent(right, identity),
      ).not.toThrow();
      expect(() =>
        fixture.boundary.assertEvidenceCurrent(oversized, identity),
      ).toThrow('oversized dependency closure');
      expect(() =>
        fixture.boundary.assertEvidenceCurrent(oversized, identity),
      ).toThrow('oversized dependency closure');
    });
  });
});
