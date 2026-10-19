import { execFileSync } from 'node:child_process';
import path from 'node:path';

export async function verifyServerHealth(
  baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/time`).catch(() => fetch(baseUrl));
    return res.ok;
  } catch {
    return false;
  }
}

export function cleanupE2eData() {
  const cleanupScript = path.resolve(__dirname, '../../backend/scripts/e2e-cleanup.js');
  execFileSync(process.execPath, [cleanupScript], { stdio: 'inherit' });
}