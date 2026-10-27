import { describe, expect, it } from 'vitest';
import type { ArtifactRef } from '../../app/contracts/artifacts.ts';
import { contractHash } from '../../app/contracts/json.ts';
import accountSnapshot from '../src/features/demos/data/damage-account.json';
import reductionSnapshot from '../src/features/demos/data/damage-reduction.json';
import {
  parseAccountDemo,
  parseReductionDemo,
  recordedArtifact,
} from '../src/features/demos/recorded-demo.ts';

function references(value: unknown): ArtifactRef[] {
  if (Array.isArray(value)) return value.flatMap(references);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  const own =
    typeof object.id === 'string' &&
    typeof object.version === 'number' &&
    typeof object.sha256 === 'string'
      ? [{ id: object.id, version: object.version, sha256: object.sha256 }]
      : [];
  return [...own, ...Object.values(object).flatMap(references)];
}

describe('recorded demo integrity', () => {
  it('includes intact artifacts for every pinned source, component and review', () => {
    for (const demo of [
      parseAccountDemo(accountSnapshot),
      parseReductionDemo(reductionSnapshot),
    ]) {
      for (const artifact of demo.artifacts)
        expect(contractHash(artifact.content)).toBe(artifact.sha256);
      for (const reference of references(demo))
        expect(
          recordedArtifact(demo.artifacts, reference),
          reference.id,
        ).toBeDefined();
    }
  });
});
