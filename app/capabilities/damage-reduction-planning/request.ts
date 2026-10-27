import type { TaskRequest } from '../../contracts/tasks.js';
import type { Artifact } from '../../contracts/artifacts.js';
import {
  reductionPreviewRequestSchema,
  reductionPreviewSelectionRequestSchema,
  type ReductionPreviewRequest,
} from '../../contracts/damage-reduction-plan.js';
import { resolveReductionSelectionRequest } from './inputs.js';

export function reductionSelectionFromScope(scope: unknown): unknown {
  if (
    scope &&
    typeof scope === 'object' &&
    !Array.isArray(scope) &&
    'schema_version' in scope &&
    (scope.schema_version === 'haze.reduction.preview-request.v1' ||
      scope.schema_version === 'haze.reduction.preview-selection-request.v1')
  ) {
    if (scope.schema_version === 'haze.reduction.preview-selection-request.v1')
      return {
        schema_version: 'haze.reduction.selection-request.v1',
        selection_ref:
          'selection_ref' in scope ? scope.selection_ref : undefined,
      };
    return 'selection' in scope ? scope.selection : undefined;
  }
  return scope;
}
/** Candidate fields stay in the authoritative scope; only numerical row declarations are dereferenced. */
export function resolveReductionPreviewRequest(
  scope: unknown,
  artifacts: readonly Artifact[],
): ReductionPreviewRequest {
  const reference = reductionPreviewSelectionRequestSchema.safeParse(scope);
  if (!reference.success) return reductionPreviewRequestSchema.parse(scope);
  return reductionPreviewRequestSchema.parse({
    schema_version: 'haze.reduction.preview-request.v1',
    selection: resolveReductionSelectionRequest(
      reductionSelectionFromScope(reference.data),
      artifacts,
    ),
    candidate: reference.data.candidate,
  });
}
export function isPlanningPreview(request: TaskRequest): boolean {
  const scope = request.scope;
  return (
    (!!scope &&
      typeof scope === 'object' &&
      !Array.isArray(scope) &&
      (scope.schema_version === 'haze.reduction.preview-request.v1' ||
        scope.schema_version ===
          'haze.reduction.preview-selection-request.v1')) ||
    /(?:conditional\s+plan|planning\s+preview|\b(?:draft|create|build|prepare|produce|develop)\b.*\bplan(?:ning)?\b)/i.test(
      request.objective,
    )
  );
}
