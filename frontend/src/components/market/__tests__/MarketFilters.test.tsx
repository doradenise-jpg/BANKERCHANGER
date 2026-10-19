import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MarketFilters } from '../MarketFilters';
import { useSearchParams, useRouter } from 'next/navigation';

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(),
  useSearchParams: jest.fn(),
}));

describe('MarketFilters Component (#926)', () => {
  const mockReplace = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({ replace: mockReplace });
  });

  it('initializes active status tab and weight class from useSearchParams', () => {
    (useSearchParams as jest.Mock).mockReturnValue({
      get: (param: string) => {
        if (param === 'status') return 'locked';
        if (param === 'weight_class') return 'Lightweight';
        if (param === 'sort') return 'pool_desc';
        return null;
      },
      toString: () => 'status=locked&weight_class=Lightweight&sort=pool_desc',
    });

    const onChangeMock = jest.fn();
    render(<MarketFilters onChange={onChangeMock} />);

    const lockedTab = screen.getByRole('tab', { name: /locked status/i });
    expect(lockedTab).toHaveAttribute('aria-selected', 'true');

    const select = screen.getByLabelText(/filter by weight class/i) as HTMLSelectElement;
    expect(select.value).toBe('Lightweight');

    expect(onChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'locked',
        weightClass: 'Lightweight',
        sort: 'pool_desc',
      })
    );
  });
});
