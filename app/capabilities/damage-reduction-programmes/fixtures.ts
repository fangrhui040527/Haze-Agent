import type { ArtifactRef } from '../../contracts/artifacts.js';
import { reductionProgrammeCreateSchema } from '../../contracts/damage-reduction-programme.js';
import { createReductionSelection } from '../damage-reduction-planning/inputs.js';
import { SYNTHETIC_REDUCTION_TARGET } from '../damage-reduction-planning/fixtures.js';
import { syntheticReductionCandidate } from '../damage-reduction-planning/planning-fixtures.js';

/** Explicit synthetic engineering programme; it starts no task automatically. */
export function syntheticProgrammeCreateRequest(original: ArtifactRef) {
  return reductionProgrammeCreateSchema.parse({
    schema_version: 'haze.reduction.programme.create.v1',
    expected_revision: 0,
    title: 'Synthetic physical damage reduction programme',
    accountable_owner: 'Synthetic local operator',
    scientific_owner: null,
    preview: {
      schema_version: 'haze.reduction.preview-request.v1',
      selection: createReductionSelection(SYNTHETIC_REDUCTION_TARGET, [
        { artifact: original, row_ids: ['baseline-1', 'intervention-1'] },
      ]),
      candidate: syntheticReductionCandidate(),
    },
  });
}
