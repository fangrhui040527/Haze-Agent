import { z } from 'zod';

/** Engineering representation bounds, not workplace or scientific limits. */
export const CONTRACT_LIMITS = {
  bytes: 1_048_576,
  depth: 64,
  identifier: 128,
  text: 4096,
  references: 256,
} as const;

export const identifierSchema = z
  .string()
  .min(1)
  .max(CONTRACT_LIMITS.identifier)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const referenceSchema = z.strictObject({
  id: identifierSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const timestampSchema = z.iso.datetime({ offset: true });
export const reasonSchema = z.strictObject({
  code: identifierSchema,
  explanation: z.string().min(1).max(CONTRACT_LIMITS.text),
});
export const inputOriginSchema = z.enum([
  'synthetic_fixture',
  'captured_operating_case',
  'live_operating_case',
]);

export type ImmutableReference = z.infer<typeof referenceSchema>;
