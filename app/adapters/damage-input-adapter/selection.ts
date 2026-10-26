import {
  boundedJsonSchema,
  type Artifact,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import {
  DAMAGE_WORLD_ADAPTER_ID,
  DAMAGE_WORLD_TOOL_ID,
  damageWorldSelectionSchema,
  type DamageWorldSelection,
} from '../../contracts/damage-world.js';
import { contractHash } from '../../contracts/json.js';
import { worldContextSnapshotSchema } from '../../contracts/world-services.js';
import type {
  ExecutionMode,
  StatefulToolStore,
  ToolContext,
} from '../../orchestration/ports.js';
import type { DamageWorldCandidate } from './ports.js';

export const exactRef = ({
  id,
  version,
  sha256,
}: ArtifactRef): ArtifactRef => ({
  id,
  version,
  sha256,
});
export const sameRef = (a: ArtifactRef, b: ArtifactRef): boolean =>
  a.id === b.id && a.version === b.version && a.sha256 === b.sha256;

export function readDamageWorldSelection(
  artifact: Artifact,
): DamageWorldSelection {
  if (
    artifact.kind !== 'damage.world-selection' ||
    artifact.producer.kind !== 'service' ||
    artifact.producer.id !== DAMAGE_WORLD_ADAPTER_ID ||
    contractHash(artifact.content) !== artifact.sha256 ||
    !artifact.required_tools.includes(DAMAGE_WORLD_TOOL_ID)
  )
    throw new Error(
      'Accounting requires an authentic World Model adapter selection.',
    );
  const selection = damageWorldSelectionSchema.parse(artifact.content);
  if (
    [selection.capture, selection.snapshot, ...selection.source_refs].some(
      (ref) =>
        !artifact.dependencies.some((dependency) => sameRef(dependency, ref)),
    )
  )
    throw new Error(
      'World Model adapter selection has an incomplete evidence closure.',
    );
  return selection;
}

/** Persist the exact evidence snapshot and service-owned selection receipt. */
export function saveDamageWorldSelection(
  store: StatefulToolStore,
  mode: ExecutionMode,
  chosen: DamageWorldCandidate,
  limitations: string[],
  context: ToolContext,
): ArtifactRef {
  const current = store.worldContext(
    context.taskId,
    context.identity,
    mode,
    chosen.record.ref.id,
  );
  const snapshot = store.saveArtifact(context.taskId, context.identity, {
    kind: 'world.context.snapshot',
    content: boundedJsonSchema.parse(
      worldContextSnapshotSchema.parse({
        schema_version: 'haze.world.context-snapshot.v1',
        stated_use: 'damage-account-inputs',
        record: chosen.record.ref,
        acceptances: current.acceptances,
        support_artifacts: [
          exactRef(chosen.capture),
          ...chosen.inputs.source_refs,
        ],
        relationships: [],
      }),
    ),
    producer: { kind: 'assignment', id: context.assignmentId },
    dependencies: [exactRef(chosen.capture), ...chosen.inputs.source_refs],
    generation: context.generation,
    assignment_revision: context.assignmentRevision,
  });
  const receipt = damageWorldSelectionSchema.parse({
    schema_version: 'haze.damage.world-selection.v1',
    adapter: DAMAGE_WORLD_ADAPTER_ID,
    version: '1',
    record: chosen.record.ref,
    capture: exactRef(chosen.capture),
    snapshot: exactRef(snapshot),
    source_refs: chosen.inputs.source_refs,
    scope_sha256: contractHash(chosen.inputs.scope),
    limitations,
  });
  const selection = store.saveArtifact(context.taskId, context.identity, {
    kind: 'damage.world-selection',
    content: receipt,
    producer: { kind: 'service', id: DAMAGE_WORLD_ADAPTER_ID },
    dependencies: [receipt.capture, ...receipt.source_refs, receipt.snapshot],
    required_tools: [DAMAGE_WORLD_TOOL_ID],
    generation: context.generation,
    evidence_origin: 'derived',
  });
  store.pinAssignmentInput(
    context.taskId,
    context.assignmentId,
    context.generation,
    exactRef(selection),
  );
  return exactRef(selection);
}
