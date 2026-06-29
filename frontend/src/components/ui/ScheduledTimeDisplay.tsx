'use client';

import { useState } from 'react';
import { formatScheduledTimeWithTz, formatScheduledTimeUTC } from '@/utils/formatScheduledTime';

interface ScheduledTimeDisplayProps {
  /** ISO 8601 timestamp */
  scheduledAt: string;
}

export function ScheduledTimeDisplay({ scheduledAt }: ScheduledTimeDisplayProps): JSX.Element {
  const [showTooltip, setShowTooltip] = useState(false);
  const localTime = formatScheduledTimeWithTz(scheduledAt);
  const utcTime = formatScheduledTimeUTC(scheduledAt);

  return (
    <div className="relative inline-block">
      <div
        className="cursor-help text-xs text-gray-300 underline underline-offset-1"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {localTime}
      </div>
      {showTooltip && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 whitespace-nowrap z-10">
          UTC: {utcTime}
        </div>
      )}
    </div>
  );
}
