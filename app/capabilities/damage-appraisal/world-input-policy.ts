import type {
  DamageWorldInputPolicy,
  DamageWorldRequest,
  DamageWorldScope,
} from '../../adapters/damage-input-adapter/ports.js';
import type { Artifact } from '../../contracts/artifacts.js';
import {
  damageScopeSchema,
  type DamageInputs,
} from '../../contracts/damage-account.js';
import {
  damageWorldScopeQuerySchema,
  type DamageWorldQuery,
} from '../../contracts/damage-world.js';
import { canonicalJson, contractHash } from '../../contracts/json.js';
import type { TaskRecord } from '../../contracts/tasks.js';
import { normalizeDamageInputs } from './inputs.js';
import { validateDamageInputs } from './scope.js';

const months = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function request(
  task: TaskRecord,
  query: DamageWorldQuery,
): DamageWorldRequest {
  const latestCorrection = task.corrections.at(-1);
  // A later prose correction may change any boundary. Earlier structured scope
  // cannot silently override it, including during receipt reuse.
  const declared = latestCorrection
    ? latestCorrection.scope
    : task.original_request.scope;
  const scope =
    declared === undefined
      ? undefined
      : damageWorldScopeQuerySchema.parse(declared);
  if (
    query.expected_scope_sha256 &&
    (declared === undefined ||
      contractHash(damageScopeSchema.parse(declared)) !==
        query.expected_scope_sha256)
  )
    throw new Error(
      'World Model scope binding differs from the current requested scope.',
    );
  if (
    declared !== undefined &&
    query.expected_scope &&
    !matchesScope(scope!, query.expected_scope)
  )
    throw new Error(
      'The World Model selection conflicts with the current requested scope.',
    );
  // Do not silently discard an unsupported correction or mix old dates and
  // record IDs with the user's latest selection. Ask when it is incomplete.
  const objective =
    latestCorrection?.passage ?? task.original_request.objective;
  const userRecordIds = [
    ...new Set(objective.match(/\bwm:[a-f0-9]{64}\b/gu) ?? []),
  ];
  const declaredScope =
    declared !== undefined &&
    (damageScopeSchema.safeParse(scope).success ||
      (!!scope?.countries?.length && !!scope.effect_period));
  return { scope, objective, declaredScope, userRecordIds };
}

function matchesScope(
  actual: DamageWorldScope,
  expected: DamageWorldScope,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) =>
      Object.hasOwn(actual, key) &&
      canonicalJson(actual[key as keyof typeof actual]) ===
        canonicalJson(value),
  );
}

function matchesObjective(
  scope: DamageInputs['scope'],
  objective: string,
  structured: boolean,
): 'match' | 'mismatch' | 'scope_required' {
  const text = objective.toLowerCase();
  if (structured) return 'match';
  // Resolve only unambiguous location + complete calendar windows. This is a
  // conservative parser, not a semantic model that can silently narrow scope.
  const timeToken =
    '(?:\\d{4}-\\d{2}-\\d{2}|(?:19|20|21)\\d{2}|' + months.join('|') + ')\\b';
  const markers = [
    ...text.matchAll(
      new RegExp(
        '\\b(?:for|in|during|from|between|on)\\s+(?=' + timeToken + ')',
        'gu',
      ),
    ),
  ];
  if (markers.length !== 1) return 'scope_required';
  const prefix = text.slice(0, markers[0]!.index).trim();
  const locationMarkers = [...prefix.matchAll(/\b(?:for|in)\s+/gu)];
  const locationStart = locationMarkers.at(-1);
  const location = locationStart
    ? prefix.slice(locationStart.index + locationStart[0].length)
    : prefix;
  const requestedCountries = location
    .split(/\s*(?:,|\band\b|&)\s*/u)
    .filter(Boolean)
    .sort();
  const actualCountries = scope.countries
    .map((country) => country.toLowerCase())
    .sort();
  if (canonicalJson(requestedCountries) !== canonicalJson(actualCountries))
    return 'mismatch';
  const periodText = text.slice(markers[0]!.index + markers[0]![0].length);
  const dates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  // Only the supported period grammar and an optional World Model suffix are
  // accepted. Extra day, currency or population constraints need clarification.
  const suffix =
    '(?:\\s+(?:using|from)\\s+(?:the\\s+)?world\\s+model(?:\\s+evidence)?)?[.!?]?\\s*$';
  let expected: { start: string; end: string };
  if (dates.length) {
    if (
      !new RegExp(
        '^\\d{4}-\\d{2}-\\d{2}\\s+(?:to|through|and|–|—)\\s+\\d{4}-\\d{2}-\\d{2}' +
          suffix,
        'u',
      ).test(periodText)
    )
      return 'scope_required';
    expected = { start: dates[0]!, end: dates[1]! };
  } else {
    const monthPattern = '(' + months.join('|') + ')';
    const monthWindow = periodText.match(
      new RegExp(
        '^' +
          monthPattern +
          '(?:\\s+(?:to|through|and|–|—)\\s+' +
          monthPattern +
          ')?\\s+((?:19|20|21)\\d{2})' +
          suffix,
        'u',
      ),
    );
    if (monthWindow) {
      const startMonth = months.indexOf(monthWindow[1]!) + 1;
      const endMonth = months.indexOf(monthWindow[2] ?? monthWindow[1]!) + 1;
      if (endMonth < startMonth) return 'scope_required';
      const year = Number(monthWindow[3]);
      expected = {
        start: `${year}-${String(startMonth).padStart(2, '0')}-01`,
        end: `${year}-${String(endMonth).padStart(2, '0')}-${new Date(Date.UTC(year, endMonth, 0)).getUTCDate()}`,
      };
    } else {
      const yearWindow = periodText.match(
        new RegExp(
          '^((?:19|20|21)\\d{2})(?:\\s+(?:to|through|and|–|—)\\s+((?:19|20|21)\\d{2}))?' +
            suffix,
          'u',
        ),
      );
      if (!yearWindow) return 'scope_required';
      expected = {
        start: `${yearWindow[1]}-01-01`,
        end: `${yearWindow[2] ?? yearWindow[1]}-12-31`,
      };
    }
  }
  return canonicalJson(expected) === canonicalJson(scope.effect_period)
    ? 'match'
    : 'mismatch';
}

function reconstruct(
  inputs: DamageInputs,
  sources: readonly Artifact[],
): DamageInputs {
  const rebuilt = validateDamageInputs(normalizeDamageInputs(sources));
  if (canonicalJson(rebuilt) !== canonicalJson(validateDamageInputs(inputs)))
    throw new Error(
      'World Model input capture disagrees with reconstruction from original evidence.',
    );
  return rebuilt;
}

/** Accounting interpretation and validation supplied to the World Model adapter. */
export const damageWorldInputPolicy: DamageWorldInputPolicy = {
  request,
  matchesScope,
  matchesObjective,
  reconstruct,
};
