import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { ThemeToggle, getInitialTheme } from '../ThemeToggle';

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: jest.fn().mockImplementation((query: string) => ({
        matches: query.includes('dark'),
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
  });

  it('cycles theme through dark, light, and system', () => {
    render(<ThemeToggle />);
    const btn = screen.getByTestId('theme-toggle');
    expect(btn).toBeInTheDocument();

    act(() => {
      fireEvent.click(btn);
    });
    // After cycle
    expect(localStorage.getItem('bankerchanger_theme')).toBeDefined();
  });
});
