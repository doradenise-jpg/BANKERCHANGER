import * as OTPAuth from 'otpauth';
import * as QRCode from 'qrcode';

export function generateSecret(accountName: string): { secret: string; otpauthUrl: string } {
  const totp = new OTPAuth.TOTP({
    issuer: 'BOXMEOUT',
    label: accountName,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret(),
  });
  return { secret: totp.secret.base32, otpauthUrl: totp.toString() };
}

export async function generateQRCode(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl);
}

/**
 * Verify a TOTP token.
 *
 * @param secret  Base32-encoded TOTP secret
 * @param token   The 6-digit code to verify
 * @param window  Allowed time-step deviation (default 1 = ±1 step = 90 s window).
 *                Narrower windows are more secure; increase only to tolerate
 *                clock skew on the client device.
 */
export function verifyToken(secret: string, token: string, window: number = 1): boolean {
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  // delta null means invalid
  return totp.validate({ token, window }) !== null;
}
