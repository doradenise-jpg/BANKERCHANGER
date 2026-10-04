// ============================================================
// BANKERCHANGER — Market Detail Page (/markets/[market_id])
// ============================================================

import type { Metadata } from 'next';
import { ErrorBoundary } from '../../../components/ui/ErrorBoundary';
import MarketDetailContent from './MarketDetailContent';
import { fetchMarketById } from '../../../services/api';

interface MarketDetailPageProps {
  params: { market_id: string };
}

export async function generateMetadata({ params }: MarketDetailPageProps): Promise<Metadata> {
  try {
    const market = await fetchMarketById(params.market_id);
    const base = process.env.NEXT_PUBLIC_BASE_URL || 'https://bankerchanger.com';
    const url = `${base}/markets/${params.market_id}`;
    const title = `${market.fighter_a} vs ${market.fighter_b} — Bet on BANKERCHANGER`;
    const description = `Bet on ${market.fighter_a} vs ${market.fighter_b} — ${market.weight_class}${market.title_fight ? ' Title Fight' : ''} on BANKERCHANGER.`;
    const imageUrl = `${base}/api/og?market=${params.market_id}`;

    return {
      title,
      description,
      canonical: url,
      openGraph: {
        title,
        description,
        type: 'website',
        url,
        siteName: 'BANKERCHANGER',
        images: [
          {
            url: imageUrl,
            width: 1200,
            height: 630,
            alt: `${market.fighter_a} vs ${market.fighter_b}`,
          },
        ],
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: [imageUrl],
      },
    };
  } catch {
    return { title: 'Market' };
  }
}

export default function MarketDetailPage({ params }: MarketDetailPageProps): JSX.Element {
  return (
    <ErrorBoundary>
      <MarketDetailContent market_id={params.market_id} />
    </ErrorBoundary>
  );
}