import { ImageResponse } from 'next/og';
import { fetchMarketById } from '@/services/api';

export const runtime = 'nodejs';
export const contentType = 'image/png';
export const size = { width: 1200, height: 630 };

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const marketId = searchParams.get('market');

  if (!marketId) {
    return new Response('Missing ?market query parameter', { status: 400 });
  }

  let market;
  try {
    market = await fetchMarketById(marketId);
  } catch {
    return new Response('Market not found', { status: 404 });
  }

  const fightDate = new Date(market.scheduled_at).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '80px',
          background: 'linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%)',
          color: '#ffffff',
          fontFamily: 'sans-serif',
        }}
      >
        {/* Brand */}
        <div
          style={{
            display: 'flex',
            fontSize: 32,
            fontWeight: 900,
            color: '#f59e0b',
            letterSpacing: '-0.02em',
          }}
        >
          BANKERCHANGER
        </div>

        {/* Fighters */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ display: 'flex', fontSize: 84, fontWeight: 900, lineHeight: 1.05 }}>
            {market.fighter_a}
          </div>
          <div style={{ display: 'flex', fontSize: 48, fontWeight: 700, color: '#f59e0b' }}>
            VS
          </div>
          <div style={{ display: 'flex', fontSize: 84, fontWeight: 900, lineHeight: 1.05 }}>
            {market.fighter_b}
          </div>
        </div>

        {/* Odds & Logos / Branding Bar */}
        {(market.odds_a != null || market.odds_b != null) && (
          <div style={{ display: 'flex', gap: 32, fontSize: 32, fontWeight: 700 }}>
            <div style={{ display: 'flex', color: '#10b981' }}>
              {market.fighter_a}: {market.odds_a ? `${(market.odds_a / 100).toFixed(1)}%` : '—'}
            </div>
            <div style={{ display: 'flex', color: '#3b82f6' }}>
              {market.fighter_b}: {market.odds_b ? `${(market.odds_b / 100).toFixed(1)}%` : '—'}
            </div>
          </div>
        )}

        {/* Meta row */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            fontSize: 28,
            color: '#9ca3af',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex' }}>
              {market.weight_class}
              {market.title_fight ? ' · Title Fight' : ''}
            </div>
            <div style={{ display: 'flex' }}>{fightDate}</div>
          </div>
          <div style={{ display: 'flex', color: '#f59e0b', fontWeight: 700 }}>
            Bet now →
          </div>
        </div>
      </div>
    ),
    size,
  );
}