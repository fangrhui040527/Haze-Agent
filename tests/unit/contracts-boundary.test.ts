import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ContractError,
  exportContractSchemas,
  parseContractJson,
  planningShape,
  validateContract,
} from '../../app/contracts/index.js';

const fixture = (path: string) =>
  parseContractJson(
    readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'),
  );

describe('v2 contract boundary', () => {
  it('validates matching planning, historical request and gap-only result specimens', () => {
    expect(() =>
      validateContract('planning', fixture('input_examples/v2/planning.json')),
    ).not.toThrow();
    expect(() =>
      validateContract(
        'run',
        fixture('input_examples/v2/run.json'),
        'historical_harness',
      ),
    ).not.toThrow();
    expect(() =>
      validateContract('result', fixture('output_examples/v2/result.json')),
    ).not.toThrow();
  });

  it('rejects demo-local request refs on the default canonical surface', () => {
    expect(() =>
      validateContract('run', fixture('input_examples/v2/run.json')),
    ).toThrow('demo_reference_requires_historical_harness');
  });

  it('rejects unsupported versions with supported versions and performs no silent migration', () => {
    for (const version of ['haze.run.v1', 'haze.run.v3', 2, undefined]) {
      try {
        validateContract('run', { schema_version: version ?? null });
        expect.fail('Expected unsupported version rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(ContractError);
        expect((error as ContractError).code).toBe(
          'unsupported_contract_version',
        );
        expect((error as ContractError).details).toEqual({
          supported_versions: ['haze.run.v2'],
        });
      }
    }
  });

  it('rejects inline facts, mode/run ID overrides, bad hashes and timezone-less timestamps', () => {
    const request = fixture('input_examples/v2/run.json');
    const planning = planningShape.parse(
      fixture('input_examples/v2/planning.json'),
    );
    planning.assessment.start = '2026-10-25T08:00:00';
    expect(() => validateContract('planning', planning)).toThrow(
      'invalid_contract',
    );
    for (const field of ['mode', 'run_id', 'inline_facts']) {
      expect(() =>
        validateContract(
          'run',
          { ...(request as object), [field]: 'override' },
          'historical_harness',
        ),
      ).toThrow('invalid_contract');
    }
    expect(() =>
      validateContract(
        'run',
        {
          schema_version: 'haze.run.v2',
          programme_id: 'demo',
          input: {
            operation: 'plan_outdoor_work',
            problem_id: 'demo',
            bundle_ref: {
              id: 'demo:bundle',
              revision: 1,
              sha256: 'not-a-hash',
            },
          },
        },
        'historical_harness',
      ),
    ).toThrow('invalid_contract');
  });

  it('exports three closed Draft 2020-12 structural schemas', () => {
    const schemas = exportContractSchemas();
    expect(Object.keys(schemas).sort()).toEqual([
      'haze.planning.v2',
      'haze.result.v2',
      'haze.run.v2',
    ]);
    for (const schema of Object.values(schemas)) {
      expect(schema.$schema).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
      expect(schema.additionalProperties).toBe(false);
      expect(schema['x-canonical-serializer']).toBe('haze.canonical-json.v1');
    }
  });
});
