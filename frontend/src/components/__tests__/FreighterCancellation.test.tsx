import { act, renderHook, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useBet } from '../../hooks/useBet';
import { ToastProvider } from '../ui/ToastProvider';
import { useAppStore } from '../../store';
import type { Market } from '../../types';

jest.mock('@stellar/stellar-sdk', () => ({
  Contract: class {
    call() { return {}; }
  },
  Networks: { PUBLIC: 'public', TESTNET: 'testnet' },
  SorobanRpc: {
    Server: class {
      async getAccount() { return {}; }
      async prepareTransaction() { return { toXDR: () => 'prepared-xdr' }; }
    },
  },
  TransactionBuilder: class {
    constructor() { return this; }
    addOperation() { return this; }
    setTimeout() { return this; }
    build() { return this; }
    static fromXDR() { return {}; }
  },
  BASE_FEE: '100',
  nativeToScVal: () => ({}),
  Address: class {},
  xdr: {},
}));

const market: Market = {
  id: 1,
  market_id: 'market-1',
  contract_address: 'contract-1',
  match_id: 'match-1',
  fighter_a: 'Fighter A',
  fighter_b: 'Fighter B',
  weight_class: 'Middleweight',
  title_fight: false,
  venue: 'Arena',
  scheduled_at: new Date().toISOString(),
  status: 'open',
  outcome: null,
  pool_a: '10000000',
  pool_b: '10000000',
  pool_draw: '0',
  total_pool: '20000000',
  fee_bps: 200,
  resolved_at: null,
  oracle_used: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ledger_sequence: 1,
  odds_a: 1,
  odds_b: 1,
  odds_draw: 0,
};

describe('Freighter transaction cancellation', () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem('bankerchanger_wallet_address', 'GTEST');
    useAppStore.getState().setWallet('GTEST', 0);
    useAppStore.getState().setTxStatus({ hash: null, status: 'idle', error: null });
    (window as any).freighter = {
      signTransaction: jest.fn().mockRejectedValue(
        Object.assign(new Error('Access declined'), { name: 'UserDeclinedAccess' }),
      ),
    };
  });

  afterEach(() => {
    delete (window as any).freighter;
  });

  it('shows the cancellation toast and restores the pre-submit bet state', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ToastProvider>{children}</ToastProvider>
    );
    const { result } = renderHook(() => useBet(market), { wrapper });

    act(() => {
      result.current.setSide('fighter_a');
      result.current.setAmount('12');
    });

    await act(async () => {
      await result.current.submitBet();
    });

    expect(await screen.findByText(
      'Transaction cancelled — you declined the request in Freighter',
    )).toBeInTheDocument();
    await waitFor(() => expect(result.current.isSubmitting).toBe(false));
    expect(result.current.side).toBe('fighter_a');
    expect(result.current.amount).toBe('12');
    expect(result.current.txStatus).toEqual({ hash: null, status: 'idle', error: null });
    expect(useAppStore.getState().lastTxStatus).toEqual({ hash: null, status: 'idle', error: null });
  });
});