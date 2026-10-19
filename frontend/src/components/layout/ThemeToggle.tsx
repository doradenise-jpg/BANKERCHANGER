'use client';

import { useEffect, useState } from 'react';

const LS_KEY = 'bankerchanger_theme';

export type Theme = 'dark' | 'light' | 'system';

export function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const stored = localStorage.getItem(LS_KEY);
  if (stored === 'dark' || stored === 'light' || stored === 'system') return stored as Theme;
  return 'system';
}

export function applyTheme(theme: Theme) {
  if (typeof window === 'undefined') return;
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
}

export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const initial = getInitialTheme();
    setTheme(initial);
    applyTheme(initial);
    setMounted(true);

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      const current = (localStorage.getItem(LS_KEY) as Theme) || 'system';
      if (current === 'system') {
        applyTheme('system');
      }
    };

    mediaQuery.addEventListener?.('change', handleChange);
    return () => mediaQuery.removeEventListener?.('change', handleChange);
  }, []);

  const cycleTheme = () => {
    const nextTheme: Theme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem(LS_KEY, nextTheme);
    applyTheme(nextTheme);
  };

  if (!mounted) {
    return <div className="w-9 h-9" aria-hidden="true" />;
  }

  return (
    <button
      onClick={cycleTheme}
      aria-label={`Current theme: ${theme}. Switch theme`}
      className="flex items-center justify-center w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
      title={`Theme: ${theme}`}
      data-testid="theme-toggle"
    >
      {theme === 'dark' ? (
        // Sun icon
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4.22 1.78a1 1 0 011.42 1.42l-.71.7a1 1 0 11-1.42-1.41l.71-.71zM18 9a1 1 0 110 2h-1a1 1 0 110-2h1zM4.22 15.78a1 1 0 001.42-1.42l-.71-.7a1 1 0 00-1.42 1.41l.71.71zM3 10a1 1 0 100 2H2a1 1 0 100-2h1zm1.22-5.78a1 1 0 00-1.42 1.42l.71.7a1 1 0 001.42-1.41l-.71-.71zM10 15a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zm5.78 1.78a1 1 0 001.42-1.42l-.71-.7a1 1 0 00-1.42 1.41l.71.71zM10 7a3 3 0 100 6 3 3 0 000-6z" clipRule="evenodd" />
        </svg>
      ) : theme === 'light' ? (
        // Moon icon
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
        </svg>
      ) : (
        // Monitor / system icon
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M3 5a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2h-2.22l.123.489.804.804A1 1 0 0113 18H7a1 1 0 01-.707-1.707l.804-.804L7.22 15H5a2 2 0 01-2-2V5zm2 0v8h10V5H5z" clipRule="evenodd" />
        </svg>
      )}
    </button>
  );
}