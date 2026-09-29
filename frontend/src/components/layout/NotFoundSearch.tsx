'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export function NotFoundSearch(): JSX.Element {
  const router = useRouter();
  const [query, setQuery] = useState('');

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = query.trim();
    const qs = trimmed ? `?search=${encodeURIComponent(trimmed)}` : '';
    router.push(`/${qs}`);
  };

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-md mb-6">
      <label htmlFor="not-found-search" className="sr-only">
        Search markets
      </label>
      <div className="flex gap-2">
        <input
          id="not-found-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search fighters or markets…"
          className="flex-1 min-h-[44px] bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white text-sm rounded-xl px-4 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-amber-500 border border-gray-300 dark:border-gray-700"
        />
        <button
          type="submit"
          className="min-h-[44px] bg-amber-500 hover:bg-amber-400 text-black font-semibold px-6 rounded-xl transition-colors"
        >
          Search
        </button>
      </div>
    </form>
  );
}