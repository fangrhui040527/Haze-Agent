import { z } from 'zod';
import {
  artifactRefSchema,
  boundedJsonSchema,
  type Artifact,
  type ArtifactRef,
} from '../../contracts/artifacts.js';
import {
  damageInputsSchema,
  damageScopeSchema,
  type DamageInputs,
} from '../../contracts/damage-account.js';
import {
  DAMAGE_WORLD_ADAPTER_ID,
  DAMAGE_WORLD_TOOL_ID,
  damageWorldLinkSchema,
  damageWorldQuerySchema,
  damageWorldResolutionSchema,
  damageWorldSelectionSchema,
  damageWorldScopeQuerySchema,
  type DamageWorldQuery,
  type DamageWorldResolution,
  type DamageWorldSelection,
} from '../../contracts/damage-world.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import type {
  ToolContext,
  ToolDefinition,
  ExecutionMode,
  StatefulToolStore,
} from '../../orchestration/ports.js';
import type { WorldRecord } from '../../contracts/world.js';
import {
  exactDamageRef,
  damageRefKey,
  normalizeDamageInputs,
} from './inputs.js';
import { validateDamageInputs } from './scope.js';
import { worldContextSnapshotSchema } from '../../contracts/world-services.js';

type Candidate = {
  record: WorldRecord;
  capture: Artifact;
  inputs: DamageInputs;
};
type ExpectedScope = NonNullable<DamageWorldQuery['expected_scope']>;
type Store = StatefulToolStore;
const sameRef = (a: ArtifactRef, b: ArtifactRef) =>
  damageRefKey(a) === damageRefKey(b);
const months = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** Read canonical accounting evidence through the task's governed World Model boundary. */
export class WorldModelDamageInputAdapter {
  constructor(
    private readonly store: Store,
    private readonly mode: ExecutionMode,
  ) {}

  resolve(
    query: DamageWorldQuery,
    context: ToolContext,
  ): DamageWorldResolution {
    const task = this.store.read(context.taskId, context.identity);
    const latestCorrection = task.corrections.at(-1);
    // A later prose correction may change any boundary. Earlier structured scope
    // cannot silently override it, including during receipt reuse.
    const declared = latestCorrection
      ? latestCorrection.scope
      : task.original_request.scope;
    const scope =
      declared === undefined
        ? undefined
        : damageWorldScopeQuerySchema.parse(declared);
    if (
      query.expected_scope_sha256 &&
      (declared === undefined ||
        contractHash(damageScopeSchema.parse(declared)) !==
          query.expected_scope_sha256)
    )
      throw new Error(
        'World Model scope binding differs from the current requested scope.',
      );
    if (
      declared !== undefined &&
      query.expected_scope &&
      !this.matchesScope(scope!, query.expected_scope)
    )
      throw new Error(
        'The World Model selection conflicts with the current requested scope.',
      );
    // Do not silently discard an unsupported correction or mix old dates and
    // record IDs with the user's latest selection. Ask when it is incomplete.
    const objective =
      latestCorrection?.passage ?? task.original_request.objective;
    const userRecordIds = [
      ...new Set(objective.match(/\bwm:[a-f0-9]{64}\b/gu) ?? []),
    ];
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
    const declaredScope =
      declared !== undefined &&
      (damageScopeSchema.safeParse(scope).success ||
        (!!scope?.countries?.length && !!scope.effect_period));
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
      if (scope && !this.matchesScope(parsed.data.scope, scope)) continue;
      const objectiveMatch = this.matchesObjective(
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
        !this.matchesScope(chosen.inputs.scope, query.expected_scope))
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
    const current = this.store.worldContext(
      context.taskId,
      context.identity,
      this.mode,
      chosen.record.ref.id,
    );
    const snapshot = this.store.saveArtifact(context.taskId, context.identity, {
      kind: 'world.context.snapshot',
      content: boundedJsonSchema.parse(
        worldContextSnapshotSchema.parse({
          schema_version: 'haze.world.context-snapshot.v1',
          stated_use: 'damage-account-inputs',
          record: chosen.record.ref,
          acceptances: current.acceptances,
          support_artifacts: [
            exactDamageRef(chosen.capture),
            ...chosen.inputs.source_refs,
          ],
          relationships: [],
        }),
      ),
      producer: { kind: 'assignment', id: context.assignmentId },
      dependencies: [
        exactDamageRef(chosen.capture),
        ...chosen.inputs.source_refs,
      ],
      generation: context.generation,
      assignment_revision: context.assignmentRevision,
    });
    const receipt = damageWorldSelectionSchema.parse({
      schema_version: 'haze.damage.world-selection.v1',
      adapter: DAMAGE_WORLD_ADAPTER_ID,
      version: '1',
      record: chosen.record.ref,
      capture: exactDamageRef(chosen.capture),
      snapshot: exactDamageRef(snapshot),
      source_refs: chosen.inputs.source_refs,
      scope_sha256: contractHash(chosen.inputs.scope),
      limitations,
    });
    const selection = this.store.saveArtifact(
      context.taskId,
      context.identity,
      {
        kind: 'damage.world-selection',
        content: receipt,
        producer: { kind: 'service', id: DAMAGE_WORLD_ADAPTER_ID },
        dependencies: [
          receipt.capture,
          ...receipt.source_refs,
          receipt.snapshot,
        ],
        required_tools: [DAMAGE_WORLD_TOOL_ID],
        generation: context.generation,
        evidence_origin: 'derived',
      },
    );
    this.store.pinAssignmentInput(
      context.taskId,
      context.assignmentId,
      context.generation,
      exactDamageRef(selection),
    );
    return {
      status: 'ready',
      inputs: this.reconstruct(chosen, context),
      selection: exactDamageRef(selection),
      limitations,
    };
  }

  private reuse(
    ref: ArtifactRef,
    context: ToolContext,
    scope: ExpectedScope | undefined,
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
    if (scope && !this.matchesScope(candidate.inputs.scope, scope))
      throw new Error(
        'World Model evidence conflicts with corrected account scope.',
      );
    const objectiveMatch = this.matchesObjective(
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
    const rebuilt = validateDamageInputs(normalizeDamageInputs(sources));
    if (
      canonicalJson(rebuilt) !==
      canonicalJson(validateDamageInputs(candidate.inputs))
    )
      throw new Error(
        'World Model input capture disagrees with reconstruction from original evidence.',
      );
    return rebuilt;
  }

  private pin(candidate: Candidate, context: ToolContext): void {
    this.store.pinWorldContext(
      context.taskId,
      context.identity,
      context.assignmentId,
      context.generation,
      this.evidence(candidate, context).map(exactDamageRef),
      'damage-account-inputs',
      candidate.record.ref.id,
    );
  }

  private evidence(candidate: Candidate, context: ToolContext): Artifact[] {
    const found = new Map<string, Artifact>();
    const pending = [
      exactDamageRef(candidate.capture),
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

  private matchesScope(
    actual: ExpectedScope,
    expected: ExpectedScope,
  ): boolean {
    return Object.entries(expected).every(
      ([key, value]) =>
        Object.hasOwn(actual, key) &&
        canonicalJson(actual[key as keyof typeof actual]) ===
          canonicalJson(value),
    );
  }

  private matchesObjective(
    scope: DamageInputs['scope'],
    objective: string,
    structured: boolean,
  ): 'match' | 'mismatch' | 'scope_required' {
    const text = objective.toLowerCase();
    if (structured) return 'match';
    // Resolve only unambiguous location + complete calendar windows. This is a
    // conservative parser, not a semantic model that can silently narrow scope.
    const timeToken =
      '(?:\\d{4}-\\d{2}-\\d{2}|(?:19|20|21)\\d{2}|' + months.join('|') + ')\\b';
    const markers = [
      ...text.matchAll(
        new RegExp(
          '\\b(?:for|in|during|from|between|on)\\s+(?=' + timeToken + ')',
          'gu',
        ),
      ),
    ];
    if (markers.length !== 1) return 'scope_required';
    const prefix = text.slice(0, markers[0]!.index).trim();
    const locationMarkers = [...prefix.matchAll(/\b(?:for|in)\s+/gu)];
    const locationStart = locationMarkers.at(-1);
    const location = locationStart
      ? prefix.slice(locationStart.index + locationStart[0].length)
      : prefix;
    const requestedCountries = location
      .split(/\s*(?:,|\band\b|&)\s*/u)
      .filter(Boolean)
      .sort();
    const actualCountries = scope.countries
      .map((country) => country.toLowerCase())
      .sort();
    if (canonicalJson(requestedCountries) !== canonicalJson(actualCountries))
      return 'mismatch';
    const periodText = text.slice(markers[0]!.index + markers[0]![0].length);
    const dates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
    // Only the supported period grammar and an optional World Model suffix are
    // accepted. Extra day, currency or population constraints need clarification.
    const suffix =
      '(?:\\s+(?:using|from)\\s+(?:the\\s+)?world\\s+model(?:\\s+evidence)?)?[.!?]?\\s*$';
    let expected: { start: string; end: string };
    if (dates.length) {
      if (
        !new RegExp(
          '^\\d{4}-\\d{2}-\\d{2}\\s+(?:to|through|and|–|—)\\s+\\d{4}-\\d{2}-\\d{2}' +
            suffix,
          'u',
        ).test(periodText)
      )
        return 'scope_required';
      expected = { start: dates[0]!, end: dates[1]! };
    } else {
      const monthPattern = '(' + months.join('|') + ')';
      const monthWindow = periodText.match(
        new RegExp(
          '^' +
            monthPattern +
            '(?:\\s+(?:to|through|and|–|—)\\s+' +
            monthPattern +
            ')?\\s+((?:19|20|21)\\d{2})' +
            suffix,
          'u',
        ),
      );
      if (monthWindow) {
        const startMonth = months.indexOf(monthWindow[1]!) + 1;
        const endMonth = months.indexOf(monthWindow[2] ?? monthWindow[1]!) + 1;
        if (endMonth < startMonth) return 'scope_required';
        const year = Number(monthWindow[3]);
        expected = {
          start: `${year}-${String(startMonth).padStart(2, '0')}-01`,
          end: `${year}-${String(endMonth).padStart(2, '0')}-${new Date(Date.UTC(year, endMonth, 0)).getUTCDate()}`,
        };
      } else {
        const yearWindow = periodText.match(
          new RegExp(
            '^((?:19|20|21)\\d{2})(?:\\s+(?:to|through|and|–|—)\\s+((?:19|20|21)\\d{2}))?' +
              suffix,
            'u',
          ),
        );
        if (!yearWindow) return 'scope_required';
        expected = {
          start: `${yearWindow[1]}-01-01`,
          end: `${yearWindow[2] ?? yearWindow[1]}-12-31`,
        };
      }
    }
    return canonicalJson(expected) === canonicalJson(scope.effect_period)
      ? 'match'
      : 'mismatch';
  }

  private gap(
    status: 'gap' | 'scope_required',
    reason: string,
  ): DamageWorldResolution {
    return { status, reasons: [reason], candidates: [] };
  }
}

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

export function createWorldModelDamageInputTool(
  store: Store,
  mode: ExecutionMode,
): ToolDefinition<DamageWorldQuery, DamageWorldResolution> {
  const adapter = new WorldModelDamageInputAdapter(store, mode);
  return {
    id: DAMAGE_WORLD_TOOL_ID,
    version: '1',
    mode,
    description:
      'Select compatible World Model accounting evidence, recheck access and currency, pin exact originals and reconstruct deterministic damage inputs. Missing evidence stays unestimated.',
    inputSchema: damageWorldQuerySchema,
    outputSchema: damageWorldResolutionSchema,
    execute: (query, context) =>
      Promise.resolve(adapter.resolve(query, context)),
  };
}
