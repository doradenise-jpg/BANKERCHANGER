/**
 * Format scheduled_at timestamp with user's timezone
 * @param isoString ISO 8601 timestamp (e.g., "2025-06-29T14:00:00Z")
 * @returns Formatted string like "Jun 29, 2:00 PM EDT" with timezone abbreviation
 */
export function formatScheduledTimeWithTz(isoString: string): string {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
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
