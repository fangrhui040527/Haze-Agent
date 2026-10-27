import { z } from 'zod';
import {
  artifactSchema,
  type Artifact,
  type ArtifactRef,
} from '../../../../app/contracts/artifacts.ts';
import { damageAccountSchema } from '../../../../app/contracts/damage-account.ts';
import { reductionPreviewViewSchema } from '../../../../app/contracts/damage-reduction-view.ts';
import { taskResultSchema } from '../../../../app/contracts/tasks.ts';

const envelope = z.strictObject({
  schema_version: z.literal('haze.browser-demo.v1'),
  recorded_at: z.iso.datetime(),
  artifacts: z.array(artifactSchema),
});

export function parseAccountDemo(value: unknown) {
  const demo = envelope
    .extend({
      account: artifactSchema,
      review: taskResultSchema.shape.review,
    })
    .parse(value);
  const account = damageAccountSchema.parse(demo.account.content);
  if (
    demo.account.kind !== 'damage.account' ||
    account.evidence_origin !== 'synthetic'
  )
    throw new Error(
      'The recorded account must contain synthetic demo evidence.',
    );
  return { ...demo, accountValue: account };
}

export function parseReductionDemo(value: unknown) {
  const demo = envelope
    .extend({ preview: reductionPreviewViewSchema })
    .parse(value);
  if (demo.preview.assessment?.value.origin !== 'synthetic')
    throw new Error(
      'The recorded preview must contain synthetic demo evidence.',
    );
  return demo;
}

export function recordedArtifact(
  artifacts: readonly Artifact[],
  reference: ArtifactRef,
): Artifact | undefined {
  return artifacts.find(
    (artifact) =>
      artifact.id === reference.id &&
      artifact.version === reference.version &&
      artifact.sha256 === reference.sha256,
  );
}

/** This reader never falls back to a live task service. */
export function recordedArtifactReader(artifacts: readonly Artifact[]) {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return (id: string): Promise<Artifact> => {
    const artifact = byId.get(id);
    return artifact
      ? Promise.resolve(artifact)
      : Promise.reject(
          new Error('This source is not included in the recorded demo.'),
        );
  };
}

export const accountDemoArtifactHref = (reference: ArtifactRef) =>
  `/demos/damage-account/artifacts/${encodeURIComponent(reference.id)}?version=${reference.version}&sha256=${reference.sha256}`;
