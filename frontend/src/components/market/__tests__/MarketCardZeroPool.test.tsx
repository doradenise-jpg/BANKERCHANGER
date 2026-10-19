import { render, screen } from '@testing-library/react';
import React from 'react';
import '@testing-library/jest-dom';
import { MarketCard } from '../MarketCard';
import { MarketOddsBar } from '../MarketOddsBar';
import type { Market } from '../../../types';

const zeroPoolMarket: Market = {
  market_id: 'test-zero-pool',
  fighter_a: 'Fighter Alpha',
  fighter_b: 'Fighter Beta',
  pool_a: '0',
  pool_b: '0',
  pool_draw: '0',
  total_pool: '0',
  status: 'open',
  scheduled_at: new Date(Date.now() + 86400000).toISOString(),
  weight_class: 'Welterweight',
  title_fight: false,
};

describe('MarketCard and MarketOddsBar with 0 Pool Volume (#932)', () => {
  it('renders MarketCard without throwing, displays No bets yet badge and clean odds bar', () => {
    render(<MarketCard market={zeroPoolMarket} />);

    expect(screen.getByTestId('no-bets-badge')).toBeInTheDocument();
    expect(screen.getByText('No bets yet')).toBeInTheDocument();
    expect(screen.getByText(/0 XLM pooled/i)).toBeInTheDocument();
    expect(screen.getByTestId('market-odds-bar')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
  });

  it('renders neutral 50/50 split when total pool volume is zero for 2-way market', () => {
    render(
      <MarketOddsBar
        pool_a="0"
        pool_b="0"
        pool_draw="0"
        fighter_a="Fighter Alpha"
        fighter_b="Fighter Beta"
      />
    );

    expect(screen.getByText('Fighter Alpha 50%')).toBeInTheDocument();
    expect(screen.getByText('Fighter Beta 50%')).toBeInTheDocument();
    expect(screen.queryByText(/Draw/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
  });

  it('renders 33/34/33 split when total pool is zero and draw is enabled', () => {
    render(
      <MarketOddsBar
        pool_a="0"
        pool_b="0"
        pool_draw="0"
        draw_enabled={true}
        fighter_a="Fighter Alpha"
        fighter_b="Fighter Beta"
      />
    );

    expect(screen.getByText('Fighter Alpha 33%')).toBeInTheDocument();
    expect(screen.getByText('Draw 34%')).toBeInTheDocument();
    expect(screen.getByText('Fighter Beta 33%')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
  });

  it('handles invalid or empty strings safely without throwing', () => {
    render(
      <MarketOddsBar
        pool_a=""
        pool_b=""
        pool_draw=""
        fighter_a="Fighter Alpha"
        fighter_b="Fighter Beta"
      />
    );

    expect(screen.getByText('Fighter Alpha 50%')).toBeInTheDocument();
    expect(screen.getByText('Fighter Beta 50%')).toBeInTheDocument();
  });
});
