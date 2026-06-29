# SEO Configuration

## robots.txt

Created at `public/robots.txt`. Disallows search engine indexing for:
- `/admin` - Admin routes
- `/payer` - Payer-only routes  
- `/governance` - Governance routes

Public routes like `/` and `/markets` are allowed and discoverable.

## Dynamic Sitemap

Created at `src/app/sitemap.ts`. Next.js automatically generates `/sitemap.xml` at request time.

### Strategy

- **Static entries**: Homepage, markets listing, portfolio, governance (for navigation structure)
- **Dynamic market entries**: Fetches all open markets from the API and includes their URLs with:
  - `lastModified`: Market creation time (or now if not available)
  - `changeFrequency`: 'hourly' (markets have active odds/liquidity)
  - `priority`: 0.8 (high priority for search discovery)

### Regeneration

The sitemap is regenerated:
1. **On every request** - Next.js ISR (Incremental Static Regeneration) processes each request dynamically
2. **Cache expiration**: Every 3600 seconds (1 hour) via `export const revalidate = 3600`
3. **Automatic on market changes**: When markets are created/resolved, the next sitemap request fetches fresh data

### Market Discovery

- Markets with `status: 'open'` are included (active betting markets)
- Resolved/closed markets are excluded (search engines will get 404 or redirects)
- Limit set to 1000 markets (covers growth projections; adjust in `fetchMarkets()` call if needed)

### Error Handling

If the API is unavailable, the sitemap still returns base structure (homepage, markets listing, etc.) so search engines don't fail entirely.

## Environment Variables

Set in your deployment:
- `NEXT_PUBLIC_SITE_URL` - Your canonical domain (defaults to `https://boxmeout.io`)
- `NEXT_PUBLIC_API_URL` - Backend API endpoint (used by `fetchMarkets()`)

## Testing

```bash
# Check robots.txt
curl http://localhost:3000/robots.txt

# Check sitemap
curl http://localhost:3000/sitemap.xml
```
