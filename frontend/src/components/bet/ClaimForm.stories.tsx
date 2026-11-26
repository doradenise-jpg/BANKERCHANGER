import type { Meta, StoryObj } from '@storybook/react';
import { ClaimForm } from './ClaimForm';

const meta: Meta<typeof ClaimForm> = {
  title: 'Components/Bet/ClaimForm',
  component: ClaimForm,
  parameters: {
    layout: 'centered',
    viewport: {
      defaultViewport: 'mobile1',
    },
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default story showing the ClaimForm with sample market ID.
 * In a real application, this would fetch actual claimable bets from the API.
 */
export const Default: Story = {
  args: {
    marketId: 'market-123',
  },
};

/**
 * Story showing the form on desktop view.
 */
export const Desktop: Story = {
  args: {
    marketId: 'market-456',
  },
  parameters: {
    viewport: {
      defaultViewport: 'desktop',
    },
  },
};
