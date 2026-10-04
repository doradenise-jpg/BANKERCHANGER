import type { Metadata } from 'next';
import Link from 'next/link';
import { NotFoundSearch } from '../components/layout/NotFoundSearch';

export const metadata: Metadata = {
  title: 'Page not found',
  description:
    'The page you are looking for does not exist. Search for boxing markets or return to the homepage.',
};

export default function NotFound(): JSX.Element {
  return (
    <main className="min-h-[60vh] flex flex-col items-center justify-center px-4 py-12 text-center">
      {/* Brand mark (matches Header) */}
      <Link
        href="/"
        className="font-black text-amber-500 text-2xl tracking-tight mb-8"
      >
        BANKERCHANGER
      </Link>

      <p className="text-6xl font-black text-amber-500 mb-4">404</p>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
        Page not found
      </h1>
      <p className="text-gray-600 dark:text-gray-400 mb-6 max-w-md">
        The page you&apos;re looking for doesn&apos;t exist or may have been
        moved. Try searching for a market or head back to the homepage.
      </p>

      {/* Search bar */}
      <NotFoundSearch />

      {/* Navigation */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Link
          href="/"
          className="min-h-[44px] inline-flex items-center justify-center bg-amber-500 hover:bg-amber-400 text-black font-semibold px-6 rounded-xl transition-colors"
        >
          Browse Markets
        </Link>
        <Link
          href="/"
          className="min-h-[44px] inline-flex items-center justify-center bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-900 dark:text-white font-semibold px-6 rounded-xl border border-gray-300 dark:border-gray-700 transition-colors"
        >
          Go to Homepage
        </Link>
      </div>
    </main>
  );
}