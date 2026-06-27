/**
 * Tests for the market detail scoped error boundary (error.tsx).
 * Verifies that a rendering error in MarketDetailContent is caught and
 * renders the fallback UI instead of crashing the whole app.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import MarketDetailError from '../../app/markets/[market_id]/error';

const mockError = new Error('Test market load failure');

describe('MarketDetailError boundary', () => {
  it('renders the scoped error message', () => {
    const reset = jest.fn();
    render(<MarketDetailError error={mockError} reset={reset} />);

    expect(screen.getByText(/failed to load market/i)).toBeInTheDocument();
  });

  it('displays the error message text', () => {
    const reset = jest.fn();
    render(<MarketDetailError error={mockError} reset={reset} />);

    expect(screen.getByText('Test market load failure')).toBeInTheDocument();
  });

  it('renders a Try Again button', () => {
    const reset = jest.fn();
    render(<MarketDetailError error={mockError} reset={reset} />);

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('calls reset() when Try Again is clicked', () => {
    const reset = jest.fn();
    render(<MarketDetailError error={mockError} reset={reset} />);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('catches a thrown error and renders fallback via ErrorBoundary', () => {
    // Suppress expected console.error from React error boundary
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const ThrowingComponent = (): JSX.Element => {
      throw new Error('Render explosion');
    };

    // Use the existing ErrorBoundary component to wrap a throwing child
    const { ErrorBoundary } = require('../../components/ui/ErrorBoundary');

    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();

    consoleSpy.mockRestore();
  });
});
