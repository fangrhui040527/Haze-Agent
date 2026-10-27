import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  damageImportSchema,
  type DamageImport,
} from '../contracts/damage-account.js';
import {
  physicalResidualImportSchema,
  reductionTargetSchema,
  type PhysicalResidualImport,
  type ReductionTarget,
} from '../contracts/damage-reduction.js';
import {
  reductionCandidateSchema,
  type ReductionCandidate,
} from '../contracts/damage-reduction-plan.js';
import { pm25ScopeSchema } from '../capabilities/pm25/contracts.js';
import {
  captureSchema,
  validateCapture,
} from '../capabilities/pm25/methods.js';
import type { EvidenceCapture } from '../capabilities/pm25/evidence.js';

const scenarioDirectories = {
  'evidence-investigation': '01-evidence',
  'damage-account': '02-damage-account',
  'damage-reduction': '03-intervention',
} as const;
export type SampleScenarioId = keyof typeof scenarioDirectories;

const common = {
  schema_version: z.literal('haze.sample-scenario.v1'),
  synthetic: z.literal(true),
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(4096),
  provenance: z.strictObject({
    origin: z.literal('locally-authored-synthetic'),
    authored_at: z.iso.datetime(),
    description: z.string().min(1).max(4096),
  }),
  gaps: z.array(z.string().min(1).max(4096)).min(1).max(32),
};
export const sampleScenarioManifestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common,
    id: z.literal('evidence-investigation'),
    kind: z.literal('pm25'),
    scope: pm25ScopeSchema,
    inputs: z.strictObject({
      capture: z.literal('pm25-capture.json'),
      notes: z.literal('source-notes.md'),
    }),
  }),
  z.strictObject({
    ...common,
    id: z.literal('damage-account'),
    kind: z.literal('damage-account'),
    inputs: z.strictObject({ damage: z.literal('damage-input.json') }),
  }),
  z.strictObject({
    ...common,
    id: z.literal('damage-reduction'),
    kind: z.literal('damage-reduction'),
    inputs: z.strictObject({
      residuals: z.literal('residual-input.json'),
      target: z.literal('target.json'),
      candidate: z.literal('candidate.json'),
    }),
  }),
]);
export type SampleScenarioManifest = z.infer<
  typeof sampleScenarioManifestSchema
>;
type ManifestOf<Kind extends SampleScenarioManifest['kind']> = Extract<
  SampleScenarioManifest,
  { kind: Kind }
>;
export type SampleScenario =
  | {
      manifest: ManifestOf<'pm25'>;
      capture: EvidenceCapture;
      notes: string;
    }
  | { manifest: ManifestOf<'damage-account'>; input: DamageImport }
  | {
      manifest: ManifestOf<'damage-reduction'>;
      input: PhysicalResidualImport;
      target: ReductionTarget;
      candidate: ReductionCandidate;
    };

const base = new URL('../../data/sample-scenarios/', import.meta.url);
function scenarioDirectory(id: string): URL {
  if (!Object.hasOwn(scenarioDirectories, id))
    throw new Error(`Unknown sample scenario: ${id}`);
  return new URL(`${scenarioDirectories[id as SampleScenarioId]}/`, base);
}
async function readJson(directory: URL, filename: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(filename, directory), 'utf8'),
  ) as unknown;
}

/** Parse raw inputs only. This loader never supplies agent actions or answers. */
export function parseSampleScenario(value: unknown): SampleScenario {
  const object = z
    .object({ manifest: sampleScenarioManifestSchema })
    .parse(value);
  const { manifest } = object;
  switch (manifest.kind) {
    case 'pm25': {
      const parsed = z
        .strictObject({
          manifest: sampleScenarioManifestSchema,
          capture: captureSchema,
          notes: z.string().min(1).max(16_000),
        })
        .parse(value);
      if (
        parsed.capture.mode !== 'fixture' ||
        parsed.capture.evidence_origin !== 'synthetic_fixture'
      )
        throw new Error(
          'Sample PM2.5 source data must be explicitly synthetic.',
        );
      validateCapture(parsed.capture, manifest.scope);
      return { manifest, capture: parsed.capture, notes: parsed.notes };
    }
    case 'damage-account': {
      const { input } = z
        .strictObject({
          manifest: sampleScenarioManifestSchema,
          input: damageImportSchema,
        })
        .parse(value);
      if (
        !input.scope ||
        !input.effects.length ||
        input.effects.some((effect) => effect.origin !== 'synthetic') ||
        input.coverage.some((coverage) => coverage.origin !== 'synthetic')
      )
        throw new Error(
          'Sample accounting inputs must be explicitly synthetic.',
        );
      return { manifest, input };
    }
    case 'damage-reduction': {
      const parsed = z
        .strictObject({
          manifest: sampleScenarioManifestSchema,
          input: physicalResidualImportSchema,
          target: reductionTargetSchema,
          candidate: reductionCandidateSchema,
        })
        .parse(value);
      if (
        parsed.input.origin !== 'synthetic' ||
        parsed.candidate.approval.status !== 'proposed' ||
        parsed.candidate.claims.some((claim) =>
          ['delivery', 'achieved_reduction'].includes(claim.kind),
        )
      )
        throw new Error(
          'Sample intervention inputs must be synthetic proposals.',
        );
      return {
        manifest,
        input: parsed.input,
        target: parsed.target,
        candidate: parsed.candidate,
      };
    }
  }
}

export async function loadSampleScenario(id: string): Promise<SampleScenario> {
  const directory = scenarioDirectory(id);
  const manifest = sampleScenarioManifestSchema.parse(
    await readJson(directory, 'scenario.json'),
  );
  if (manifest.id !== id)
    throw new Error('The sample manifest ID does not match.');
  switch (manifest.kind) {
    case 'pm25':
      return parseSampleScenario({
        manifest,
        capture: await readJson(directory, manifest.inputs.capture),
        notes: await readFile(
          new URL(manifest.inputs.notes, directory),
          'utf8',
        ),
      });
    case 'damage-account':
      return parseSampleScenario({
        manifest,
        input: await readJson(directory, manifest.inputs.damage),
      });
    case 'damage-reduction':
      return parseSampleScenario({
        manifest,
        input: await readJson(directory, manifest.inputs.residuals),
        target: await readJson(directory, manifest.inputs.target),
        candidate: await readJson(directory, manifest.inputs.candidate),
      });
  }
}

export async function listSampleScenarios(): Promise<SampleScenarioManifest[]> {
  return Promise.all(
    Object.keys(scenarioDirectories).map(async (id) => {
      const scenario = await loadSampleScenario(id);
      return scenario.manifest;
    }),
  );
}
