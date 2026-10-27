import { z } from 'zod';

/** Network research requires a task opt-in in addition to an assignment grant. */
export const EVIDENCE_RESEARCH_TOOL_IDS = [
  'haze-web-search',
  'haze-captured-excerpt',
  'haze-damage-evidence-plan',
  'haze-damage-data-acquire',
  'haze-damage-document-acquire',
] as const;
export const evidenceResearchToolIdSchema = z.enum(EVIDENCE_RESEARCH_TOOL_IDS);

export function evidenceResearchToolGranted(
  request: { scope?: unknown; evidence_tools?: readonly string[] | undefined },
  tool: string,
): boolean {
  if (!(EVIDENCE_RESEARCH_TOOL_IDS as readonly string[]).includes(tool))
    return true;
  const scope = request.scope;
  return (
    request.evidence_tools?.includes(tool) === true ||
    (typeof scope === 'object' &&
      scope !== null &&
      'capability' in scope &&
      scope.capability === 'damage-evidence-research')
  );
}
