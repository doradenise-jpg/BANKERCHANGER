'use client';

import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';

type NavLink = { href: string; label: string };

const FOCUSABLE = 'a, button, [tabindex]:not([tabindex="-1"])';

export function HeaderMobileNav({
  links,
  pathname,
}: {
  links: NavLink[];
  pathname: string;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!menuOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        return;
      }
      if (e.key !== 'Tab' || !navRef.current) return;
      const focusable = Array.from(navRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKey);
    const firstFocusable = navRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    firstFocusable?.focus();

    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const linkClass = (href: string) =>
    `hover:text-white transition-colors ${pathname === href ? 'text-white font-semibold border-b-2 border-amber-500 pb-0.5' : 'text-gray-400'}`;

  return (
    <>
      <button
        className="md:hidden flex items-center justify-center w-11 h-11 text-gray-400 hover:text-white"
        onClick={() => setMenuOpen((o) => !o)}
        aria-label="Toggle menu"
        aria-expanded={menuOpen}
        aria-controls="mobile-navigation-dialog"
      >
        ☰
      </button>

      {menuOpen && (
        <nav
          id="mobile-navigation-dialog"
          ref={navRef}
          role="dialog"
          aria-modal="true"
          aria-label="Mobile navigation"
          className="md:hidden bg-gray-950 border-t border-gray-800 px-4 py-2 flex flex-col text-sm"
        >
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMenuOpen(false)}
              className={`flex items-center min-h-[44px] ${linkClass(href)}`}
            >
              {label}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
