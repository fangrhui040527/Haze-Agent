import type { TaskRequest } from '../../contracts/tasks.js';

export function reductionSelectionFromScope(scope: unknown): unknown {
  if (
    scope &&
    typeof scope === 'object' &&
    !Array.isArray(scope) &&
    'schema_version' in scope &&
    scope.schema_version === 'haze.reduction.preview-request.v1'
  )
    return 'selection' in scope ? scope.selection : undefined;
  return scope;
}
export function isPlanningPreview(request: TaskRequest): boolean {
  const scope = request.scope;
  return (
    (!!scope &&
      typeof scope === 'object' &&
      !Array.isArray(scope) &&
      scope.schema_version === 'haze.reduction.preview-request.v1') ||
    /(?:conditional\s+plan|planning\s+preview|\b(?:draft|create|build|prepare|produce|develop)\b.*\bplan(?:ning)?\b)/i.test(
      request.objective,
    )
  );
}
