# Payer Dashboard — `/payer`

This route renders the **Payer Dashboard**, the invoice settlement interface for users who owe payment on funded invoices within the BANKERCHANGER platform.

## Purpose

A "payer" is the counterparty on a funded invoice — the entity that borrowed against an invoice and must return the funds once the underlying work is complete. This dashboard lets them:

- View all outstanding invoices assigned to their connected Stellar wallet where `status === 'Funded'`
- See due dates with overdue highlighting
- Settle an invoice by signing a Stellar transaction via `markPaid()`, which triggers the on-chain release

## Route

| Path | Component | Auth |
|------|-----------|------|
| `/payer` | `PayerDashboard` | Wallet connection required |

## Key behaviour

- Invoices are filtered client-side by `payer === connectedAddress && status === 'Funded'`
- Overdue invoices (past due date) are highlighted in red
- On settlement, the invoice is immediately marked `Paid` in local state and removed after 3 seconds
- Uses `TxStatusToast` to surface transaction signing / broadcast / error state

## Data source

Currently uses **mock data** (`MOCK_INVOICES`) to simulate the ILN (Invoice Liquidity Network) invoice feed. The real integration will replace this with an API call to the backend `/invoices` endpoint once the ILN connector is complete — see issue #85.
