import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function cleanupE2eData() {
  const cleanupScript = path.resolve(__dirname, '../../backend/scripts/e2e-cleanup.js');
  execFileSync(process.execPath, [cleanupScript], { stdio: 'inherit' });
}