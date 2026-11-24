# ClaimForm Component

A React component for claiming winning bets on resolved markets in BANKERCHANGER.

## Usage

```tsx
import { ClaimForm } from '@/components/bet/ClaimForm';

export function MyPage() {
  return (
    <ClaimForm marketId="market-123" />
  );
}
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `marketId` | `string` | Yes | The ID of the market to load claimable bets from |

## Features

### Automatic Bet Filtering
- Fetches all bets placed by the connected wallet
- Filters for resolved markets with outcomes
- Shows only winning bets that haven't been claimed yet
- Displays user-friendly error message if no claimable bets exist

### Interactive Selection
- Individual checkboxes for each bet
- "Select All" / "Deselect All" functionality
- Indeterminate checkbox state for partial selection
- Keyboard accessible (Tab, Space, Enter)

### Real-time Calculations
- Displays payout for each bet in XLM
- Shows gain percentage vs. original bet amount
- Real-time total payout calculation
- Updates as selections change

### Wallet Integration
- Requires connected wallet
- Shows ConnectPrompt if wallet not connected
- Integrates with Freighter and other Stellar wallets
- Handles transaction signing and broadcasting

### Transaction Management
- Displays transaction status (signing, broadcasting, confirming)
- Shows confirmation modal on success
- Links to Stellar Expert block explorer
- Auto-dismisses toast after 6 seconds
- Error handling with user-friendly messages

### Accessibility
- Full keyboard navigation
- Semantic HTML
- ARIA labels for screen readers
- Visible focus states
- Role="status" for dynamic content updates

## State Flow

```
1. User lands on ClaimForm
2. Component checks wallet connection
   - If not connected → show ConnectPrompt
   - If connected → fetch bets
3. Bets are fetched and filtered
   - If none found → show empty state
   - If error → show error message
   - If found → display list
4. User selects bets
   - Total payout updates in real-time
5. User clicks "Claim X Bets"
   - Component calls claimWinnings(marketId)
   - Wallet prompts for signature
6. Transaction is submitted
   - Toast shows signing/broadcasting/confirming states
   - On success → show modal with transaction hash
   - On error → show error message
7. User dismisses modal
   - Selection clears
   - User can claim new bets
```

## Styling

The component uses Tailwind CSS with a dark theme:
- Background: `bg-gray-900`
- Accent colors: `amber-500` (primary), `green-600` (claim button)
- Text: `text-white` with varying opacity for hierarchy
- Responsive: Mobile-first design

## Integration Requirements

### Hooks
- `useClaimWinnings(address)` - Handles wallet transaction
- `useWallet()` - Gets wallet connection state
- `useAppStore()` - Updates global transaction status

### APIs
- `fetchBetsByMarket(marketId: string)` - Gets all market bets
- `fetchMarketById(marketId: string)` - Gets market details

### Components
- `ConnectPrompt` - Shown when wallet not connected
- `TxStatusToast` - Shows transaction status updates

## Type Definitions

```tsx
interface ClaimFormProps {
  marketId: string;
}

interface ClaimableBet extends Bet {
  market?: Market;
}
```

## Error Handling

The component handles:
- Network errors when fetching bets
- Wallet not connected
- No claimable bets found
- Transaction signing failures
- API errors with descriptive messages

Error messages are displayed in a dismissible alert box.

## Performance

- Fetches bets only once on mount (when wallet connects)
- Memoizes calculations (totalPayout, sorting)
- Uses React.memo for child components
- Efficient state updates with Set for selections
- Lazy load market details on demand

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari, Chrome Android)

## Testing

Manual testing checklist:
- [ ] Connect/disconnect wallet
- [ ] Load page with no claimable bets
- [ ] Load page with multiple claimable bets
- [ ] Select/deselect individual bets
- [ ] Test Select All checkbox
- [ ] Verify total payout updates
- [ ] Submit claim and check wallet prompt
- [ ] Verify success modal with tx hash
- [ ] Test error scenarios (network down, etc.)
- [ ] Mobile responsiveness
- [ ] Keyboard navigation
- [ ] Screen reader (VoiceOver, NVDA)

## Examples

### Basic Usage
```tsx
<ClaimForm marketId="market-123" />
```

### In a Market Page
```tsx
export function MarketPage({ params }) {
  return (
    <div className="container">
      <MarketHeader marketId={params.id} />
      <div className="grid gap-6">
        <BetForm marketId={params.id} />
        <ClaimForm marketId={params.id} />
        <BetHistoryTable marketId={params.id} />
      </div>
    </div>
  );
}
```

### With Custom Styling
Wrap in a div with custom classes if needed:
```tsx
<div className="p-4 bg-gray-800 rounded-xl">
  <ClaimForm marketId="market-123" />
</div>
```

## Related Components

- `BetForm` - Place new bets
- `BetHistoryTable` - View all bets with filtering
- `BetList` - Simple bet listing
- `TxStatusToast` - Transaction notifications

## Common Issues

**"No claimable bets found"**
- Market must be resolved
- You must have winning bets
- Winning bets cannot already be claimed
- Check market status in explorer

**"Connect Wallet" prompt**
- Wallet not connected or detected
- Try connecting with Freighter
- Ensure wallet is on correct Stellar network

**"Transaction failed"**
- Check wallet has sufficient XLM for fees
- Market contract may have issues
- Try submitting again

## Contributing

To modify the component:
1. Update types in `types/index.ts` if needed
2. Modify component logic in `ClaimForm.tsx`
3. Update stories in `ClaimForm.stories.tsx`
4. Test manually with real market data
5. Update this README with any breaking changes
