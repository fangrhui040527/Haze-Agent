import { z } from 'zod';
import {
  physicalResidualImportSchema,
  reductionTargetSchema,
} from '../dist/contracts/damage-reduction.js';
import { reductionCandidateSchema } from '../dist/contracts/damage-reduction-plan.js';
import { canonicalJson } from '../dist/contracts/json.js';
import { candidateEvidenceReferences } from '../dist/capabilities/damage-reduction-planning/planning.js';

const packageSchema = z.strictObject({
  schema_version: z.literal('haze.reduction.live-package.v1'),
  target: reductionTargetSchema,
  candidate: reductionCandidateSchema,
  sources: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u),
        input: physicalResidualImportSchema,
        row_ids: z.array(z.string().min(1)).min(1).max(1000),
      }),
    )
    .min(1)
    .max(16),
});

/** Validate declarations before any model call; never manufacture missing inputs. */
export function parsePlanningPackage(value) {
  const parsed = packageSchema.safeParse(value);
  if (!parsed.success)
    return {
      package: null,
      gaps: parsed.error.issues.map(
        (issue) => `invalid_package:${issue.path.join('.')}:${issue.message}`,
      ),
    };
  const input = parsed.data;
  const gaps = [];
  // This package version imports residual declarations into a fresh store.
  // Pre-existing UUID references cannot name those newly assigned artifacts.
  if (candidateEvidenceReferences(input.candidate).length)
    gaps.push('unsupported_candidate_evidence_refs');
  const names = new Set();
  const selected = [];
  for (const source of input.sources) {
    if (names.has(source.name))
      gaps.push(`duplicate_source_name:${source.name}`);
    names.add(source.name);
    if (source.input.origin !== 'supplied')
      gaps.push(`supplied_residual_input_required:${source.name}`);
    const rows = new Map();
    for (const row of source.input.records) {
      if (rows.has(row.row_id))
        gaps.push(`duplicate_source_row:${source.name}:${row.row_id}`);
      rows.set(row.row_id, row);
    }
    const ids = new Set();
    for (const id of source.row_ids) {
      if (ids.has(id)) gaps.push(`duplicate_selected_row:${source.name}:${id}`);
      ids.add(id);
      const row = rows.get(id);
      if (!row) {
        gaps.push(`selected_row_missing:${source.name}:${id}`);
        continue;
      }
      selected.push(row);
      if (canonicalJson(row.scope) !== canonicalJson(input.target.scope))
        gaps.push(`incompatible_scope:${source.name}:${id}`);
      if (row.quantity === null)
        gaps.push(`unknown_residual_quantity:${source.name}:${id}`);
    }
  }
  if (selected.length > 1000) gaps.push('selected_row_limit_exceeded');
  for (const role of ['baseline', 'intervention'])
    if (!selected.some((row) => row.role === role))
      gaps.push(`missing_${role}_rows`);
  return { package: input, gaps: [...new Set(gaps)] };
}
