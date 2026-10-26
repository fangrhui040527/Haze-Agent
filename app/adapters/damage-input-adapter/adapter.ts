import { z } from 'zod';
import {
  artifactRefSchema,
  type Artifact,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import {
  damageInputsSchema,
  type DamageInputs,
} from '../../contracts/damage-account.js';
import {
  damageWorldLinkSchema,
  type DamageWorldQuery,
  type DamageWorldResolution,
} from '../../contracts/damage-world.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import type {
  ToolContext,
  ExecutionMode,
  StatefulToolStore,
} from '../../orchestration/ports.js';
import type {
  DamageWorldCandidate as Candidate,
  DamageWorldInputPolicy,
  DamageWorldScope,
} from './ports.js';
import {
  exactRef,
  sameRef,
  readDamageWorldSelection,
  saveDamageWorldSelection,
} from './selection.js';

type Store = StatefulToolStore;

/** Read canonical accounting evidence through the task's governed World Model boundary. */
export class WorldModelDamageInputAdapter {
  constructor(
    private readonly store: Store,
    private readonly mode: ExecutionMode,
    private readonly policy: DamageWorldInputPolicy,
  ) {}

  resolve(
    query: DamageWorldQuery,
    context: ToolContext,
  ): DamageWorldResolution {
    const task = this.store.read(context.taskId, context.identity);
    const { scope, objective, declaredScope, userRecordIds } =
      this.policy.request(task, query);
    if (userRecordIds.length > 1)
      return this.gap(
        'scope_required',
        'Select one World Model record for this account.',
      );
    const userRecordId = userRecordIds[0];
    if (query.record_id && userRecordId && query.record_id !== userRecordId)
      throw new Error(
        'World Model query differs from the user-selected record.',
      );
    if (query.selection_ref)
      return this.reuse(
        query.selection_ref,
        context,
        scope,
        objective,
        declaredScope,
        userRecordId,
      );
    this.store.clearWorldContextPins(
      context.taskId,
      context.identity,
      context.assignmentId,
      context.generation,
    );
    // Filter in SQLite before reading payloads; never pick the latest arbitrary artifact.
    // A model's proposed ID must not hide alternative matching evidence sets.
    // Only a record explicitly selected by the user can narrow discovery to one.
    const recordId = userRecordId;
    const lookup = recordId
      ? {
          records: [
            this.store.worldContext(
              context.taskId,
              context.identity,
              this.mode,
              recordId,
            ).record,
          ],
        }
      : this.store.worldLookup(context.taskId, context.identity, this.mode, {
          kind: 'artifact_reference',
          artifact_kind: 'damage.inputs',
          limit: 50,
        });
    if (!recordId && lookup.records.length === 50)
      return this.gap(
        'gap',
        'The bounded World Model candidate window is full. A narrower indexed selection is required; no incomplete scan was used.',
      );
    const candidates: Candidate[] = [];
    const rejected: string[] = [];
    let needsScope = false;
    for (const record of lookup.records) {
      if (record.kind !== 'artifact_reference') continue;
      const payload = z
        .object({ artifact: artifactRefSchema })
        .parse(record.payload);
      const capture = this.store.artifact(
        payload.artifact.id,
        context.identity,
        payload.artifact,
      );
      const parsed = damageInputsSchema.safeParse(capture.content);
      if (!parsed.success) continue;
      if (scope && !this.policy.matchesScope(parsed.data.scope, scope))
        continue;
      const objectiveMatch = this.policy.matchesObjective(
        parsed.data.scope,
        objective,
        !!userRecordId || declaredScope,
      );
      if (objectiveMatch === 'scope_required') needsScope = true;
      if (objectiveMatch !== 'match') continue;
      try {
        this.checkCandidate({ record, capture, inputs: parsed.data }, context);
        candidates.push({ record, capture, inputs: parsed.data });
      } catch (error) {
        rejected.push(
          error instanceof Error
            ? error.message
            : 'World Model evidence is unusable.',
        );
      }
    }
    const unique = [
      ...new Map(
        candidates.map((c) => [
          contractHash({
            scope: c.inputs.scope,
            sources: c.inputs.source_refs,
          }),
          c,
        ]),
      ).values(),
    ];
    if (!unique.length && needsScope)
      return this.gap(
        'scope_required',
        'Which location, episode and dates should the account cover? The backend will retrieve the evidence; no upload is required.',
      );
    if (!unique.length)
      return this.gap(
        'gap',
        rejected[0] ??
          'World Model has no usable accounting inputs matching the request. Backend acquisition or an approved physical-effect calculation is required; no upload is needed.',
      );
    if (unique.length > 1)
      return {
        status: 'ambiguous',
        reasons: [
          'Several different scoped evidence sets match. Specify the episode, dates or account to select; no latest-record guess was made.',
        ],
        candidates: unique
          .slice(0, 10)
          .map((c) => ({ record: c.record.ref, scope: c.inputs.scope })),
      };
    const chosen = unique[0]!;
    if (
      (query.record_id && chosen.record.ref.id !== query.record_id) ||
      (query.expected_scope &&
        !this.policy.matchesScope(chosen.inputs.scope, query.expected_scope))
    )
      return this.gap(
        'gap',
        'The proposed World Model selector differs from the uniquely compatible requested evidence. Clarify the request before changing the selected scope.',
      );
    const limitations = [
      'World Model storage and numerical agreement do not establish scientific applicability or causal attribution.',
      'Only already retained physical quantities and compatible unit values are reused; no exposure-to-health calculation or external acquisition is performed by this adapter.',
    ];
    this.pin(chosen, context);
    const selection = saveDamageWorldSelection(
      this.store,
      this.mode,
      chosen,
      limitations,
      context,
    );
    return {
      status: 'ready',
      inputs: this.reconstruct(chosen, context),
      selection,
      limitations,
    };
  }

  private reuse(
    ref: ArtifactRef,
    context: ToolContext,
    scope: DamageWorldScope | undefined,
    objective: string,
    declaredScope: boolean,
    userRecordId?: string,
  ): DamageWorldResolution {
    const linked = context.inputs.some((artifact) => {
      const link = damageWorldLinkSchema.safeParse(artifact.content);
      return (
        artifact.kind === 'damage.world-inputs' &&
        link.success &&
        sameRef(link.data.selection, ref) &&
        artifact.dependencies.some((d) => sameRef(d, ref))
      );
    });
    if (!linked)
      throw new Error(
        'World Model selection was not pinned by the collecting assignment.',
      );
    const artifact = this.store.artifact(ref.id, context.identity, ref);
    const selection = readDamageWorldSelection(artifact);
    if (userRecordId && selection.record.id !== userRecordId)
      throw new Error(
        'Retained World Model selection differs from the user-selected record.',
      );
    const world = this.store.worldContext(
      context.taskId,
      context.identity,
      this.mode,
      selection.record.id,
    );
    if (canonicalJson(world.record.ref) !== canonicalJson(selection.record))
      throw new Error(
        'The selected World Model record was revised. Collect fresh accounting evidence.',
      );
    const capture = this.store.artifact(
      selection.capture.id,
      context.identity,
      selection.capture,
    );
    const candidate = {
      record: world.record,
      capture,
      inputs: damageInputsSchema.parse(capture.content),
    };
    if (scope && !this.policy.matchesScope(candidate.inputs.scope, scope))
      throw new Error(
        'World Model evidence conflicts with corrected account scope.',
      );
    const objectiveMatch = this.policy.matchesObjective(
      candidate.inputs.scope,
      objective,
      !!userRecordId || declaredScope,
    );
    if (objectiveMatch === 'scope_required')
      return this.gap(
        'scope_required',
        'Clarify the current account location, episode and dates before reusing retained evidence. No upload is required.',
      );
    if (objectiveMatch !== 'match')
      throw new Error(
        'Retained World Model evidence conflicts with the current request.',
      );
    if (
      contractHash(candidate.inputs.scope) !== selection.scope_sha256 ||
      canonicalJson(candidate.inputs.source_refs) !==
        canonicalJson(selection.source_refs)
    )
      throw new Error(
        'World Model selection does not match its exact input capture.',
      );
    this.checkCandidate(candidate, context);
    this.pin(candidate, context);
    this.store.pinAssignmentInput(
      context.taskId,
      context.assignmentId,
      context.generation,
      ref,
    );
    return {
      status: 'ready',
      inputs: this.reconstruct(candidate, context),
      selection: ref,
      limitations: selection.limitations,
    };
  }

  private checkCandidate(candidate: Candidate, context: ToolContext): void {
    const { record, capture, inputs } = candidate;
    if (record.scope.mode !== this.mode || capture.kind !== 'damage.inputs')
      throw new Error('World Model input mode or kind is incompatible.');
    if (
      this.mode === 'live' &&
      (capture.evidence_origin === 'synthetic_fixture' ||
        inputs.effects.some((e) => e.origin === 'synthetic') ||
        inputs.coverage.some((e) => e.origin === 'synthetic'))
    )
      throw new Error(
        'Synthetic evidence cannot supply a live damage account.',
      );
    const current = this.store.worldContext(
      context.taskId,
      context.identity,
      this.mode,
      record.ref.id,
    );
    if (
      current.acceptances.some((a) =>
        ['held', 'superseded', 'not_eligible'].includes(a.status),
      )
    )
      throw new Error(
        'World Model input is held, superseded or ineligible for reuse.',
      );
    if (this.store.world.activeHolds(record.scope, record.ref.id).length)
      throw new Error('World Model input has an active hold.');
    if (inputs.source_refs.length > 63)
      throw new Error(
        'Accounting evidence exceeds the bounded World Model input selection.',
      );
    for (const source of this.evidence(candidate, context)) {
      if (
        source.identity.principal !== context.identity.principal ||
        source.identity.workspace !== context.identity.workspace
      )
        throw new Error('World Model input belongs to another workspace.');
      if (source.task_id) {
        const owner = this.store.read(source.task_id, context.identity);
        if (owner.mode !== this.mode)
          throw new Error('World Model input execution mode changed.');
        const applicability = owner.artifacts.find(
          (a) =>
            sameRef(a.artifact, source) &&
            a.objective_revision === owner.objective_revision,
        );
        if (!applicability?.current)
          throw new Error(
            'World Model source is no longer current in its originating task.',
          );
        if (source.assignment_id) {
          const producer = owner.assignments.find(
            (a) => a.id === source.assignment_id,
          );
          if (
            !producer ||
            producer.revision !== source.assignment_revision ||
            producer.status !== 'completed' ||
            ['gap', 'unknown'].includes(producer.support) ||
            ['stale', 'rejected'].includes(producer.usability)
          )
            throw new Error(
              'World Model source producer is incomplete, superseded or rejected.',
            );
        }
      }
      const refs = this.store.world.lookup(record.scope, {
        kind: 'artifact_reference',
        external_id: 'artifact:' + source.id + ':' + source.version,
        limit: 1,
      });
      if (
        refs.some(
          (r) =>
            this.store.world.activeHolds(record.scope, r.ref.id).length > 0,
        )
      )
        throw new Error('A supporting World Model source has an active hold.');
    }
    this.reconstruct(candidate, context);
  }

  private reconstruct(
    candidate: Candidate,
    context: ToolContext,
  ): DamageInputs {
    const sources = candidate.inputs.source_refs.map((ref) => {
      if (!candidate.capture.dependencies.some((d) => sameRef(d, ref)))
        throw new Error(
          'Accounting capture does not retain its original source dependency.',
        );
      return this.store.artifact(ref.id, context.identity, ref);
    });
    return this.policy.reconstruct(candidate.inputs, sources);
  }

  private pin(candidate: Candidate, context: ToolContext): void {
    this.store.pinWorldContext(
      context.taskId,
      context.identity,
      context.assignmentId,
      context.generation,
      this.evidence(candidate, context).map(exactRef),
      'damage-account-inputs',
      candidate.record.ref.id,
    );
  }

  private evidence(candidate: Candidate, context: ToolContext): Artifact[] {
    const found = new Map<string, Artifact>();
    const pending = [
      exactRef(candidate.capture),
      ...candidate.inputs.source_refs,
    ];
    while (pending.length) {
      const ref = pending.pop()!;
      const previous = found.get(ref.id);
      if (previous) {
        if (!sameRef(previous, ref))
          throw new Error(
            'Conflicting evidence versions in World Model input closure.',
          );
        continue;
      }
      if (found.size >= 64)
        throw new Error(
          'World Model accounting dependency closure exceeds 64 artifacts.',
        );
      const artifact = this.store.artifact(ref.id, context.identity, ref);
      found.set(ref.id, artifact);
      pending.push(...artifact.dependencies);
    }
    return [...found.values()];
  }

  private gap(
    status: 'gap' | 'scope_required',
    reason: string,
  ): DamageWorldResolution {
    return { status, reasons: [reason], candidates: [] };
  }
}
