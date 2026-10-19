'use client';

// ============================================================
// BANKERCHANGER — CountdownTimer Component (Issue #931)
// ============================================================

import { useState, useEffect } from 'react';
import { getSynchronizedNow } from '../../hooks/useMarketCountdown';

interface CountdownTimerProps {
  /** ISO 8601 timestamp of target time */
  targetDate: string;
  /** Optional label for context (e.g. "Betting closes in") */
  label?: string;
}

function formatDDHHMMSS(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const dd = Math.floor(totalSec / 86400);
  const hh = Math.floor((totalSec % 86400) / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(dd)}:${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

export function CountdownTimer({ targetDate, label }: CountdownTimerProps): JSX.Element {
  const targetMs = new Date(targetDate).getTime();
  const [mounted, setMounted] = useState(false);
  const [remaining, setRemaining] = useState<number>(0);

  useEffect(() => {
    setMounted(true);
    const update = () => {
      const now = typeof getSynchronizedNow === 'function' ? getSynchronizedNow() : Date.now();
      const r = targetMs - now;
      setRemaining(r);
      return r;
    };
    const initial = update();
    if (initial <= 0) return;

    const id = setInterval(() => {
      const r = update();
      if (r <= 0) clearInterval(id);
    }, 1000);

    return () => clearInterval(id);
  }, [targetMs]);

  // Static placeholder during SSR and before client hydration to prevent mismatch
  if (!mounted) {
    return (
      <span className="text-sm text-gray-200" aria-hidden="true">
        {label && <span className="text-gray-400 mr-1">{label}</span>}
        <span className="font-mono text-amber-400">--:--:--:--</span>
      </span>
    );
  }

  if (remaining <= 0) {
    return <span className="text-sm text-gray-400">Betting Closed</span>;
  }

  return (
    <span className="text-sm text-gray-200">
      {label && <span className="text-gray-400 mr-1">{label}</span>}
      <span className="font-mono text-amber-400">{formatDDHHMMSS(remaining)}</span>
    </span>
  );
}
