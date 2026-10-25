import { createHash } from 'node:crypto';
import { CONTRACT_LIMITS } from './common.js';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const CANONICAL_SERIALIZER_VERSION = 'haze.canonical-json.v1';

/** JSON.parse alone silently discards duplicate keys and accepts overflow as Infinity. */
export function parseContractJson(
  source: string,
  maximumBytes: number = CONTRACT_LIMITS.bytes,
): JsonValue {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 8 * CONTRACT_LIMITS.bytes
  )
    throw new Error('invalid_json_byte_bound');
  if (Buffer.byteLength(source, 'utf8') > maximumBytes) {
    throw new Error('contract_too_large');
  }
  let position = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/.test(source[position] ?? '\u0000')) position++;
  };
  const fail = (code: string): never => {
    throw new Error(`${code} at JSON offset ${position}`);
  };
  const string = (): string => {
    const start = position++;
    while (position < source.length) {
      const character = source[position++];
      if (character === '\\') position++;
      else if (character === '"') {
        let value: unknown;
        try {
          value = JSON.parse(source.slice(start, position));
        } catch {
          return fail('invalid_json_string');
        }
        if (typeof value !== 'string') return fail('invalid_json_string');
        return value;
      }
    }
    return fail('unterminated_json_string');
  };
  const value = (depth: number): JsonValue => {
    if (depth > CONTRACT_LIMITS.depth) return fail('contract_too_deep');
    whitespace();
    const character = source[position];
    if (character === '"') return string();
    if (character === '{') {
      position++;
      const object: { [key: string]: JsonValue } = {};
      const keys = new Set<string>();
      whitespace();
      if (source[position] === '}') {
        position++;
        return object;
      }
      for (;;) {
        whitespace();
        if (source[position] !== '"') return fail('expected_json_key');
        const key = string();
        if (keys.has(key)) return fail('duplicate_json_key');
        keys.add(key);
        whitespace();
        if (source[position++] !== ':') return fail('expected_json_colon');
        Object.defineProperty(object, key, {
          value: value(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        whitespace();
        const separator = source[position++];
        if (separator === '}') return object;
        if (separator !== ',') return fail('expected_json_separator');
      }
    }
    if (character === '[') {
      position++;
      const array: JsonValue[] = [];
      whitespace();
      if (source[position] === ']') {
        position++;
        return array;
      }
      for (;;) {
        array.push(value(depth + 1));
        whitespace();
        const separator = source[position++];
        if (separator === ']') return array;
        if (separator !== ',') return fail('expected_json_separator');
      }
    }
    for (const [token, literal] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (source.startsWith(token, position)) {
        position += token.length;
        return literal;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      source.slice(position),
    )?.[0];
    if (!number) return fail('invalid_json_value');
    position += number.length;
    const parsed = Number(number);
    if (!Number.isFinite(parsed)) return fail('nonfinite_json_number');
    return parsed;
  };
  const parsed = value(0);
  whitespace();
  if (position !== source.length) return fail('unexpected_json_suffix');
  return parsed;
}

/** UTF-16 key order, ECMAScript number/string encoding, no insignificant whitespace. */
export function canonicalJson(
  value: unknown,
  maximumBytes: number = CONTRACT_LIMITS.bytes,
): string {
  const seen = new Set<object>();
  const encode = (item: unknown, depth: number): string => {
    if (depth > CONTRACT_LIMITS.depth) throw new Error('contract_too_deep');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') {
      return JSON.stringify(item);
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new Error('non_json_value');
    if (seen.has(item)) throw new Error('cyclic_json_value');
    seen.add(item);
    let encoded: string;
    if (Array.isArray(item)) {
      encoded = `[${Array.from(item, (entry: unknown) => encode(entry, depth + 1)).join(',')}]`;
    } else {
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) {
        throw new Error('non_json_object');
      }
      const record = item as Record<string, unknown>;
      encoded = `{${Object.keys(record)
        .sort()
        .map(
          (key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`,
        )
        .join(',')}}`;
    }
    seen.delete(item);
    return encoded;
  };
  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded, 'utf8') > maximumBytes) {
    throw new Error('contract_too_large');
  }
  return encoded;
}

export function contractHash(
  value: unknown,
  maximumBytes: number = CONTRACT_LIMITS.bytes,
): string {
  return createHash('sha256')
    .update(canonicalJson(value, maximumBytes), 'utf8')
    .digest('hex');
}
