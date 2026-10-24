const relativeFormat = new Intl.RelativeTimeFormat('en', {
  numeric: 'auto',
  style: 'short',
});

/** "5 min. ago", "2 hr. ago", "in 3 hr." */
export function timeAgo(iso: string, now: number): string {
  const diffSeconds = Math.round((Date.parse(iso) - now) / 1000);
  const abs = Math.abs(diffSeconds);
  // Small clock differences (e.g. a timestamp a few ms "in the future") still read as "just now".
  if (abs < 45) return 'just now';
  if (abs < 3600)
    return relativeFormat.format(Math.round(diffSeconds / 60), 'minute');
  if (abs < 86400)
    return relativeFormat.format(Math.round(diffSeconds / 3600), 'hour');
  return relativeFormat.format(Math.round(diffSeconds / 86400), 'day');
}

/** e.g. "23 Oct, 14:05" in the given IANA time zone (or the viewer's zone if omitted). */
export function formatDateTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

/** e.g. "UTC+7" for a time zone at a given moment. */
export function utcOffsetLabel(iso: string, timeZone: string): string {
  const part = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    timeZoneName: 'shortOffset',
  })
    .formatToParts(new Date(iso))
    .find((p) => p.type === 'timeZoneName');
  return part?.value.replace('GMT', 'UTC') ?? timeZone;
}

export function hoursBetween(isoA: string, nowMs: number): number {
  return (nowMs - Date.parse(isoA)) / 3_600_000;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
