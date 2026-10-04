# SEO Configuration

## robots.txt

Created at `public/robots.txt`. Disallows search engine indexing for:
- `/admin` - Admin routes
- `/payer` - Payer-only routes  
- `/governance` - Governance routes

Public routes like `/` and `/markets` are allowed and discoverable.

## Dynamic Sitemap

Created at `src/app/sitemap.ts`. Next.js generates `/sitemap.xml` on the server and caches the result using incremental static regeneration.

### Strategy

- **Static entries**: Homepage, markets listing, portfolio, governance (for navigation structure)
- **Dynamic market entries**: Fetches all open markets from the API and includes their URLs with:
  - `lastModified`: Market `updated_at` timestamp when it is valid
  - `changeFrequency`: 'hourly' (markets have active odds/liquidity)
  - `priority`: 0.8 (high priority for search discovery)

### Regeneration

The sitemap is cached for 3600 seconds (1 hour) via `export const revalidate = 3600`; after that interval, the next request refreshes the server-generated sitemap.

### Market Discovery

- Markets with `status: 'open'` are included (active betting markets)
- Resolved/closed markets are excluded (search engines will get 404 or redirects)
- Limit set to 1000 markets (covers growth projections; adjust in `fetchMarkets()` call if needed)
- URLs are absolute, use the configured canonical site origin, and include valid `lastmod` values only when the API supplies a valid `updated_at` timestamp.

### Error Handling

If the API is unavailable, the sitemap still returns base structure (homepage, markets listing, etc.) so search engines don't fail entirely.

## Environment Variables

Set in your deployment:
- `NEXT_PUBLIC_SITE_URL` - Your canonical domain (defaults to `https://bankerchanger.io`)
- `NEXT_PUBLIC_API_URL` - Backend API endpoint (used by `fetchMarkets()`)

## Testing

```bash
# Check robots.txt
curl http://localhost:3000/robots.txt

# Check sitemap
curl http://localhost:3000/sitemap.xml
```
