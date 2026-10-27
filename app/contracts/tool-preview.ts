import { z } from 'zod';

/** Bounded, explicitly untrusted text selected by a registered retrieval tool. */
export const toolPreviewSchema = z
  .strictObject({
    schema_version: z.literal('haze.tool.preview.v1'),
    notice: z.string().max(512),
    items: z
      .array(
        z.record(
          z.string().max(60),
          z.union([z.string().max(6000), z.number(), z.boolean(), z.null()]),
        ),
      )
      .max(5),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 10_000,
    'Tool preview exceeds 10 kB.',
  );
export type ToolPreview = z.infer<typeof toolPreviewSchema>;
