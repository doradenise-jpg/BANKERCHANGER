/**
 * E2E: Security Headers Validation
 *
 * Tests that CSP and security headers are present on all page responses.
 */

import { afterAll, test, expect } from '@playwright/test';
import { cleanupE2eData } from './cleanup';

afterAll(cleanupE2eData);

function parseCsp(header: string): Map<string, string[]> {
  return new Map(
    header
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name.toLowerCase(), sources]),
  );
}

test.describe('Security Headers', () => {
  const pages = ['/', '/portfolio', '/markets'];
  const requiredCspDirectives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': [
      "'self'",
      'https://horizon-testnet.stellar.org',
      'https://horizon.stellar.org',
      'https://soroban-testnet.stellar.org',
      'https://soroban-rpc.stellar.org',
    ],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
  };

  pages.forEach((pagePath) => {
    test(`CSP header present on ${pagePath}`, async ({ page }) => {
      const response = await page.goto(pagePath);
      
      expect(response?.status()).toBeLessThan(400);
      
      const cspHeader = response?.headers()['content-security-policy'];
      expect(cspHeader).toBeDefined();

      const directives = parseCsp(cspHeader!);
      expect([...directives.keys()].sort()).toEqual(
        Object.keys(requiredCspDirectives).sort(),
      );
      for (const [name, expectedSources] of Object.entries(requiredCspDirectives)) {
        expect(directives.get(name)?.sort()).toEqual([...expectedSources].sort());
      }
    });

    test(`X-Frame-Options header present on ${pagePath}`, async ({ page }) => {
      const response = await page.goto(pagePath);
      
      const xFrameOptions = response?.headers()['x-frame-options'];
      expect(xFrameOptions).toBe('DENY');
    });

    test(`X-Content-Type-Options header present on ${pagePath}`, async ({ page }) => {
      const response = await page.goto(pagePath);
      
      const xContentType = response?.headers()['x-content-type-options'];
      expect(xContentType).toBe('nosniff');
    });

    test(`Referrer-Policy header present on ${pagePath}`, async ({ page }) => {
      const response = await page.goto(pagePath);
      
      const referrerPolicy = response?.headers()['referrer-policy'];
      expect(referrerPolicy).toBe('strict-origin');
    });
  });
});
