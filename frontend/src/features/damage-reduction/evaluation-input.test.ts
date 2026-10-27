import { describe, expect, it } from 'vitest';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import {
  evaluationTaskViewSchema,
  programmeEvaluationProjectionSchema,
} from '../../../../app/contracts/damage-reduction-evaluation.ts';
import {
  readEvaluationInput,
  readEvaluationDossier,
  parseEvaluationRecord,
  evaluationRecordTemplate,
} from './evaluation-input.ts';
import {
  evaluationInput,
  evaluationDossier,
  evaluationTask,
  evaluationProjection,
} from './evaluation-test-fixtures.ts';
import { artifactRef } from '../../services/agents/testFixtures.ts';

describe('external evaluation input boundary', () => {
  it('retains synthetic original estimates and unadopted dossier declarations', () => {
    const input = readEvaluationInput({
      content: JSON.stringify(evaluationInput()),
    } as Artifact);
    expect(input.origin).toBe('synthetic');
    expect(input.comparative_estimates).toEqual({
      baseline: '1000',
      intervention: '880',
    });
    const dossier = readEvaluationDossier({
      content: JSON.stringify(evaluationDossier()),
    } as Artifact);
    expect(dossier.origin).toBe('synthetic');
    expect(dossier.decision).toBe('conditional');
    expect(evaluationTaskViewSchema.parse(evaluationTask())).toEqual(
      evaluationTask(),
    );
    expect(
      programmeEvaluationProjectionSchema.parse(evaluationProjection()),
    ).toEqual(evaluationProjection());
  });
  it('rejects imported authority flags and excess numeric precision rather than normalizing them', () => {
    expect(() =>
      readEvaluationInput({
        content: JSON.stringify({ ...evaluationInput(), qualified: true }),
      } as Artifact),
    ).toThrow();
    const input = evaluationInput();
    input.comparative_estimates.baseline = '0.1234567890123';
    expect(() =>
      readEvaluationInput({ content: JSON.stringify(input) } as Artifact),
    ).toThrow();
  });
  it('creates an unqualified editable adoption guide with exact refs and blank human attestations', () => {
    const guide = evaluationRecordTemplate('evaluation_qualification', {
      result: artifactRef,
      review: artifactRef,
      dossier: artifactRef,
    });
    expect(guide).toMatchObject({
      decision: 'unqualified',
      adopted_by: '',
      attested_at: '',
      result_ref: artifactRef,
      dossier_ref: artifactRef,
    });
    expect(() =>
      parseEvaluationRecord(JSON.stringify(guide), 'evaluation_qualification'),
    ).toThrow();
  });
  it('preserves explicit withdrawal/supersession records and rejects mismatched kind or oversized records', () => {
    const record = {
      kind: 'evaluation_qualification',
      decision: 'withdrawn',
      result_ref: artifactRef,
      technical_review_ref: artifactRef,
      dossier_ref: artifactRef,
      adopted_by: 'Local scientific operator',
      attested_at: '2026-10-27T00:00:00Z',
      reason: 'Withdraw the prior local adoption.',
      supersedes_record_id: artifactRef.id,
    };
    expect(
      parseEvaluationRecord(JSON.stringify(record), 'evaluation_qualification'),
    ).toEqual(record);
    expect(() =>
      parseEvaluationRecord(JSON.stringify(record), 'evaluation_objection'),
    ).toThrow('match the selected');
    expect(() =>
      parseEvaluationRecord('x'.repeat(65537), 'evaluation_objection'),
    ).toThrow('64 KiB');
  });
});
