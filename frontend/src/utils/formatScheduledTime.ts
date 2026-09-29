/**
 * Format scheduled_at timestamp with user's timezone
 * @param isoString ISO 8601 timestamp (e.g., "2025-06-29T14:00:00Z")
 * @returns Formatted string like "Sun, Jun 29 · 10:00 AM PDT"
 */
export function formatScheduledTimeWithTz(
  isoString: string,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const date = new Date(isoString);
  const localDate = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(date);
  const localTime = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(date);

  return `${localDate} · ${localTime}`;
}

/**
 * Format scheduled_at as UTC for tooltip/clarity
 * @param isoString ISO 8601 timestamp
 * @returns Formatted UTC string like "Jun 29, 2:00 PM UTC"
 */
export function formatScheduledTimeUTC(isoString: string): string {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date);
}
