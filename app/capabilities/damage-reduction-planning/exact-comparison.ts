/** Fixed decimal representation shared by producers; independent checkers do not import this module. */
export const EXACT_DECIMAL_SCALE = 1_000_000_000_000n;
export function assertExactIntegerBound(value: bigint): bigint {
  if (value.toString().replace('-', '').length > 128)
    throw new Error('exact_intermediate_overflow');
  return value;
}
/** Callers validate the canonical decimal source token before conversion. */
export function parseExactDecimal(value: string): bigint {
  const sign = value.startsWith('-') ? -1n : 1n;
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return assertExactIntegerBound(
    sign * BigInt(`${whole}${fraction.padEnd(12, '0')}`),
  );
}
export function renderExactDecimal(value: bigint): string {
  const magnitude = (value < 0n ? -value : value).toString().padStart(13, '0');
  const fraction = magnitude.slice(-12).replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${magnitude.slice(0, -12)}${fraction ? `.${fraction}` : ''}`;
}
/** No division or rounding: compare (baseline-intervention)*scale against fraction*baseline. */
export function compareExactResiduals(
  baseline: bigint,
  intervention: bigint,
  fraction: string,
  relation: 'at_least' | 'greater_than',
) {
  assertExactIntegerBound(baseline);
  assertExactIntegerBound(intervention);
  const difference = assertExactIntegerBound(baseline - intervention);
  const quantities = {
    baseline_damage: renderExactDecimal(baseline),
    intervention_damage: renderExactDecimal(intervention),
    absolute_reduction: renderExactDecimal(difference),
  };
  const reason =
    baseline <= 0n
      ? 'positive_baseline_required'
      : intervention < 0n
        ? 'nonnegative_intervention_required'
        : null;
  if (reason)
    return {
      ...quantities,
      relative_reduction: null,
      target_met: null,
      reason,
    };
  const left = assertExactIntegerBound(difference * EXACT_DECIMAL_SCALE);
  const right = assertExactIntegerBound(parseExactDecimal(fraction) * baseline);
  return {
    ...quantities,
    relative_reduction: {
      numerator: quantities.absolute_reduction,
      denominator: quantities.baseline_damage,
    },
    target_met: relation === 'at_least' ? left >= right : left > right,
    reason: null,
  };
}
