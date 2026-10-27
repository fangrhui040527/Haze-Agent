/** Keep model artifacts bounded while retaining originals and explicit omission counts. */
export function boundEvidenceGaps(
  input: Iterable<string>,
  maximumEntries = 200,
): {
  gaps: string[];
  omitted_gap_count: number;
} {
  const gaps: string[] = [];
  const seen = new Set<string>();
  let omitted = 0;
  if (
    !Number.isSafeInteger(maximumEntries) ||
    maximumEntries < 1 ||
    maximumEntries > 200
  )
    throw new Error('Invalid evidence gap bound.');
  for (const entry of input) {
    const detail =
      entry.length > 1900
        ? `${entry.slice(0, 1900)} [detail truncated; original evidence retained]`
        : entry;
    if (seen.has(detail)) continue;
    if (gaps.length < maximumEntries - 1) {
      gaps.push(detail);
      seen.add(detail);
    } else omitted++;
  }
  if (omitted)
    gaps.push(
      `${omitted} additional gap entries omitted from this bounded manifest; original evidence remains retained for reconstruction.`,
    );
  return { gaps, omitted_gap_count: omitted };
}
