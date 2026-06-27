'use client';

import { useEffect } from 'react';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Scoped error boundary for the market detail page.
 * Catches rendering errors in this route segment only — the rest of the
 * app stays functional.
 */
export default function MarketDetailError({ error, reset }: ErrorProps): JSX.Element {
  useEffect(() => {
    console.error('[MarketDetailError]', error);
  }, [error]);

  return (
    <main className="max-w-6xl mx-auto px-4 py-16 text-center space-y-4">
      <p className="text-lg font-semibold text-white">Failed to load market</p>
      <p className="text-sm text-gray-400">
        {error.message ?? 'An unexpected error occurred.'}
      </p>
      <button
        onClick={reset}
        className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 font-semibold text-black text-sm"
      >
        Try Again
      </button>
    </main>
  );
}
