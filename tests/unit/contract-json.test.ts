import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  contractHash,
  parseContractJson,
} from '../../app/contracts/json.js';

describe('contract JSON boundary', () => {
  it('rejects duplicate and escaped duplicate keys instead of losing accepted facts', () => {
    expect(() => parseContractJson('{"x":1,"x":2}')).toThrow(
      'duplicate_json_key',
    );
    expect(() => parseContractJson('{"nested":{"x":1,"\\u0078":2}}')).toThrow(
      'duplicate_json_key',
    );
    expect(parseContractJson('{"a":{"x":1},"b":{"x":2}}')).toEqual({
      a: { x: 1 },
      b: { x: 2 },
    });
  });

  it('rejects malformed, overflow, oversized and deeply nested JSON', () => {
    for (const source of [
      '{"x":1,}',
      '[1,]',
      '01',
      'null true',
      '{"x":1e999}',
      'NaN',
      '"\\q"',
    ]) {
      expect(() => parseContractJson(source)).toThrow();
    }
    expect(() =>
      parseContractJson('['.repeat(66) + '0' + ']'.repeat(66)),
    ).toThrow('contract_too_deep');
    expect(() => parseContractJson(' '.repeat(1_048_577))).toThrow(
      'contract_too_large',
    );
  });

  it('preserves JSON escape semantics and treats prototype keys as data', () => {
    const source = JSON.stringify({
      ['__proto__']: { polluted: true },
      text: 'a"b\\c\n',
    });
    expect(parseContractJson(source)).toEqual(JSON.parse(source));
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('uses reproducible key ordering and changes the digest when content changes', () => {
    expect(canonicalJson({ z: [2, 1], a: { b: true } })).toBe(
      '{"a":{"b":true},"z":[2,1]}',
    );
    expect(contractHash({ a: 1, b: 2 })).toBe(contractHash({ b: 2, a: 1 }));
    expect(contractHash({ a: 1 })).not.toBe(contractHash({ a: 2 }));
    for (const value of [Infinity, undefined, { x: undefined }, new Date()]) {
      expect(() => canonicalJson(value)).toThrow();
    }
  });
});
