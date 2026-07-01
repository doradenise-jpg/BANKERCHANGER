import { MetadataRoute } from 'next';
import { fetchMarkets } from '@/services/api';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://boxmeout.io';

export const revalidate = 3600; // Revalidate every hour

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: `${SITE_URL}/markets`,
      lastModified: new Date(),
      changeFrequency: 'hourly',
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/portfolio`,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/governance`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.6,
    },
  ];

  try {
    // Fetch all open markets for sitemap discovery
    const { markets } = await fetchMarkets({ status: 'open' }, { limit: 1000 });
    
    markets.forEach((market) => {
      entries.push({
        url: `${SITE_URL}/markets/${market.id}`,
        lastModified: market.created_at ? new Date(market.created_at) : new Date(),
        changeFrequency: 'hourly',
        priority: 0.8,
      });
    });
  } catch (error) {
    console.error('Failed to fetch markets for sitemap:', error);
    // Continue with base URLs if fetch fails
  }

  return entries;
}
