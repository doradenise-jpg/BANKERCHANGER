import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BetConfirmModal } from '../BetConfirmModal';

function makeProps(overrides: Partial<React.ComponentProps<typeof BetConfirmModal>> = {}) {
  return {
    isOpen: true,
    fighter_a: 'Fighter Alpha',
    fighter_b: 'Fighter Beta',
    side: 'fighter_a' as const,
    amount_xlm: 100,
    estimated_payout_xlm: 190,
    fee_bps: 200,
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
    ...overrides,
  };
}

describe('BetConfirmModal', () => {
  it('renders gross, fee, and net payout lines', () => {
    render(<BetConfirmModal {...makeProps()} />);

    expect(screen.getByText(/you pay/i)).toBeInTheDocument();
    expect(screen.getByText(/platform fee/i)).toBeInTheDocument();
    expect(screen.getByText(/net payout/i)).toBeInTheDocument();
  });

  it('computes fee amount and percentage from fee_bps', () => {
    render(<BetConfirmModal {...makeProps({ amount_xlm: 100, fee_bps: 200 })} />);

    // 200 bps = 2.00%; 2% of 100 XLM = 2.0000 XLM
    expect(screen.getByText(/platform fee \(2\.00%\)/i)).toBeInTheDocument();
    expect(screen.getByTestId('fee-amount')).toHaveTextContent('2.0000 XLM');
  });

  it('renders the net payout exactly as passed in (already fee-adjusted)', () => {
    render(<BetConfirmModal {...makeProps({ estimated_payout_xlm: 190 })} />);

    expect(screen.getByTestId('net-payout')).toHaveTextContent('190.0000 XLM');
  });

  it('renders the gross amount in the You pay row', () => {
    render(<BetConfirmModal {...makeProps({ amount_xlm: 100 })} />);

    expect(screen.getByText('100.0000 XLM')).toBeInTheDocument();
  });

  it('shows a tooltip explaining the fee structure', () => {
    render(<BetConfirmModal {...makeProps()} />);

    const tooltip = screen.getByLabelText(/fee explanation/i);
    expect(tooltip).toHaveAttribute('title', expect.stringMatching(/fee/i));
  });

  it('renders nothing when closed', () => {
    const { container } = render(<BetConfirmModal {...makeProps({ isOpen: false })} />);
    expect(container).toBeEmptyDOMElement();
  });
});