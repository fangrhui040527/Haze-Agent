import type { Artifact } from '../../contracts/artifacts.js';
import type { DamageInputs } from '../../contracts/damage-account.js';
import type { DamageWorldQuery } from '../../contracts/damage-world.js';
import type { TaskRecord } from '../../contracts/tasks.js';
import type { WorldRecord } from '../../contracts/world.js';

export interface DamageWorldCandidate {
  record: WorldRecord;
  capture: Artifact;
  inputs: DamageInputs;
}

export type DamageWorldScope = NonNullable<DamageWorldQuery['expected_scope']>;
export interface DamageWorldRequest {
  scope: DamageWorldScope | undefined;
  objective: string;
  declaredScope: boolean;
  userRecordIds: string[];
}

/** Composition supplies domain rules; the adapter never imports capabilities. */
export interface DamageWorldInputPolicy {
  request(task: TaskRecord, query: DamageWorldQuery): DamageWorldRequest;
  matchesScope(actual: DamageWorldScope, expected: DamageWorldScope): boolean;
  matchesObjective(
    scope: DamageInputs['scope'],
    objective: string,
    structured: boolean,
  ): 'match' | 'mismatch' | 'scope_required';
  reconstruct(inputs: DamageInputs, sources: readonly Artifact[]): DamageInputs;
}
