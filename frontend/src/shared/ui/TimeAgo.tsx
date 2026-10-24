import { useNow } from '../hooks/hooks.ts';
import { formatDateTime, timeAgo } from '../lib/time.ts';

/** "5 min. ago" with the exact time (viewer's time zone) in a tooltip and for screen readers. */
export function TimeAgo({ iso, prefix }: { iso: string; prefix?: string }) {
  const now = useNow(15_000);
  const exact = formatDateTime(iso);
  return (
    <time
      dateTime={iso}
      title={`${prefix ? `${prefix} ` : ''}${exact} (your time)`}
    >
      {timeAgo(iso, now)}
    </time>
  );
}
