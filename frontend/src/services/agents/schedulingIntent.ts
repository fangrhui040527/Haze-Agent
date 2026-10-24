export const KLANG_CREW_EXAMPLE =
  'Using the fictional Klang crew sample, compare the baseline and alternative schedules for 25 October 2026, 08:00–12:00, and explain which option qualifies.';

/** Selects a capability; it never turns chat text into accepted operating facts. */
export function isCrewSchedulingRequest(question: string): boolean {
  return (
    /\b(crew|workers?|klang)\b/i.test(question) &&
    /\b(schedul\w*|rosters?|shifts?|plan(?:ning)?\s+(?:outdoor\s+)?work)\b/i.test(
      question,
    )
  );
}

export function requestsKlangSample(question: string): boolean {
  return (
    /\bklang\b/i.test(question) &&
    /\b(sample|fictional|demo|example)\b/i.test(question)
  );
}
