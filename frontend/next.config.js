/** @type {import('next').NextConfig} */
if (!process.env.NEXT_PUBLIC_API_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_URL must be set. See frontend/.env.example for details.',
  );
}

const nextConfig = {
  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    const scriptSrc = isProd ? "'self' 'unsafe-inline'" : "'self' 'unsafe-inline' 'unsafe-eval'";
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';

    const cspHeader = `
      default-src 'self';
      script-src ${scriptSrc};
      style-src 'self' 'unsafe-inline';
      img-src 'self' data: https:;
      font-src 'self' data:;
      connect-src 'self' ${apiUrl} https://horizon-testnet.stellar.org https://horizon.stellar.org https://soroban-testnet.stellar.org https://soroban-rpc.stellar.org wss: ws:;
      frame-ancestors 'none';
      object-src 'none';
    `.replace(/\n/g, '').replace(/\s+/g, ' ').trim();

    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: cspHeader,
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin',
          },
        ],
      },
    ];
  },
};

const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
});

module.exports = withBundleAnalyzer(nextConfig);