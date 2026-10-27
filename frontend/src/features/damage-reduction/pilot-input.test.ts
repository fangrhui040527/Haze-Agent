import { describe, expect, it } from 'vitest';
import {
  pilotInputSchema,
  pilotTaskViewSchema,
  syntheticPilotInputExample,
} from '../../../../app/contracts/damage-reduction-pilot.ts';
import type { Artifact } from '../../../../app/contracts/artifacts.ts';
import {
  parsePilotRecord,
  pilotRecordTemplate,
  pilotValidationMessage,
  readPilotInputSource,
} from './pilot-input.ts';
import { programmeView } from './programme-test-fixtures.ts';
import { pilotInput, pilotTaskView } from './pilot-test-fixtures.ts';
import { artifactRef } from '../../services/agents/testFixtures.ts';

describe('pilot input and typed-record boundary', () => {
  it('retains explicitly synthetic original JSON without inventing missing science', () => {
    const source = { content: JSON.stringify(pilotInput()) } as Artifact;
    const input = readPilotInputSource(source);
    expect(input.origin).toBe('synthetic');
    expect(input.design_review).toBeNull();
    expect(input.protocol_spec.analysis_method).toBeNull();
    expect(pilotInputSchema.parse(input)).toEqual(input);
    expect(pilotTaskViewSchema.parse(pilotTaskView())).toEqual(pilotTaskView());
    expect(() =>
      readPilotInputSource({ content: '{"origin":"supplied"}' } as Artifact),
    ).toThrow();
  });
  it('loads an explicit engineering example without case-specific scientific findings or live approval', () => {
    const programme = programmeView().programme;
    const input = syntheticPilotInputExample(
      programme.preview.selection.target,
      programme.preview.candidate.kind,
    );
    expect(pilotInputSchema.parse(input)).toEqual(input);
    expect(input.origin).toBe('synthetic');
    expect(input.findings).toHaveLength(8);
    expect(
      input.findings.every((finding) => finding.status === 'unknown'),
    ).toBe(true);
    expect(input.calculations).toEqual([]);
    expect(input.design_review).toBeNull();
    expect(input.protocol_spec.digital_rule?.approval.status).toBe('proposed');
  });
  it('creates editable registration guidance bound to exact reviewed artifacts with blank timing attestations', () => {
    const guide = pilotRecordTemplate(
      'pilot_registration',
      programmeView().programme,
      pilotTaskView(),
    );
    expect(guide).toMatchObject({
      protocol_ref: artifactRef,
      feasibility_ref: artifactRef,
      review_ref: artifactRef,
      outcome_access: {
        collection: 'unknown',
        analysis: 'unknown',
        attested_at: '',
        attested_by: '',
      },
    });
    expect(() =>
      parsePilotRecord(JSON.stringify(guide), 'pilot_registration'),
    ).toThrow();
  });
  it('defaults action guidance to simulated and proposed, requiring a supplied event time', () => {
    const guide = pilotRecordTemplate(
      'digital_action',
      programmeView().programme,
      pilotTaskView(),
    );
    expect(guide).toMatchObject({
      mode: 'simulated',
      action_version: '',
      permitted_action: 'Synthetic alert only',
      status: 'proposed',
      rule: { id: 'fixture-alert', version: '2' },
      occurred_at: '',
      receipt_ref: null,
    });
    expect(() =>
      parsePilotRecord(JSON.stringify(guide), 'digital_action'),
    ).toThrow();
  });
  it('validates kind and bounds each record while keeping larger payloads as exact imports', () => {
    const valid = {
      kind: 'delivery_verification',
      registration_id: null,
      action_record_ids: [programmeView().programme.id],
      verification_ref: artifactRef,
    };
    expect(
      parsePilotRecord(JSON.stringify(valid), 'delivery_verification'),
    ).toEqual(valid);
    expect(() =>
      parsePilotRecord(JSON.stringify(valid), 'digital_action'),
    ).toThrow('match the selected');
    expect(() => parsePilotRecord('x'.repeat(65537), 'digital_action')).toThrow(
      '64 KiB',
    );
    expect(pilotValidationMessage(new Error('Invalid supplied time'))).toBe(
      'Invalid supplied time',
    );
  });
});
