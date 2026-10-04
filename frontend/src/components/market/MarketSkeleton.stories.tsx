import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { MarketCardSkeleton } from './MarketCardSkeleton';
import { MarketDetailSkeleton } from './MarketDetailSkeleton';

const meta: Meta = {
  title: 'Components/Skeletons/Market',
};

export default meta;

export const CardSkeleton: StoryObj = {
  render: () => (
    <div className="max-w-md p-4 bg-gray-950">
      <MarketCardSkeleton />
    </div>
  ),
};

export const DetailSkeleton: StoryObj = {
  render: () => (
    <div className="bg-gray-950 p-6 min-h-screen">
      <MarketDetailSkeleton />
    </div>
  ),
};
