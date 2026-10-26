import { z } from 'zod';
import { artifactRefSchema } from './artifacts.js';
import { damageInputsSchema, damageScopeSchema } from './damage-account.js';

export const DAMAGE_WORLD_ADAPTER_ID = 'world-model-damage-input-adapter';
export const DAMAGE_WORLD_TOOL_ID = 'damage.world-inputs';
const recordRef = z.strictObject({
  id: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const reason = z.string().min(1).max(4096);
/** A selector must not acquire default constraints absent from the request. */
export const damageWorldScopeQuerySchema = damageScopeSchema.partial().extend({
  presentation_decimal_places:
    damageScopeSchema.shape.presentation_decimal_places
      .removeDefault()
      .optional(),
});

/** A service-owned receipt, never a model's copy of numerical inputs. */
export const damageWorldSelectionSchema = z.strictObject({
  schema_version: z.literal('haze.damage.world-selection.v1'),
  adapter: z.literal(DAMAGE_WORLD_ADAPTER_ID),
  version: z.literal('1'),
  record: recordRef,
  capture: artifactRefSchema,
  snapshot: artifactRefSchema,
  source_refs: z.array(artifactRefSchema).min(1).max(63),
  scope_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  limitations: z.array(reason).max(64),
});
export const damageWorldLinkSchema = z.strictObject({
  schema_version: z.literal('haze.damage.world-inputs.v1'),
  selection: artifactRefSchema,
});
export const damageWorldQuerySchema = z
  .strictObject({
    expected_scope: damageWorldScopeQuerySchema.optional(),
    expected_scope_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    record_id: z.string().min(1).max(128).optional(),
    selection_ref: artifactRefSchema.optional(),
  })
  .refine(
    (value) => !(value.selection_ref && value.record_id),
    'Select either a retained receipt or a World Model record.',
  );
export const damageWorldResolutionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    inputs: damageInputsSchema,
    selection: artifactRefSchema,
    limitations: z.array(reason).max(64),
  }),
  z.strictObject({
    status: z.enum(['gap', 'scope_required', 'ambiguous']),
    reasons: z.array(reason).min(1).max(64),
    candidates: z
      .array(z.strictObject({ record: recordRef, scope: damageScopeSchema }))
      .max(10),
  }),
]);
export type DamageWorldSelection = z.infer<typeof damageWorldSelectionSchema>;
export type DamageWorldQuery = z.infer<typeof damageWorldQuerySchema>;
export type DamageWorldResolution = z.infer<typeof damageWorldResolutionSchema>;
