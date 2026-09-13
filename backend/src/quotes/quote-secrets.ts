import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export function newShareToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: sha256(token) };
}
export function newAcceptanceCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
/** The low-entropy code must be keyed, not a brute-forceable plain SHA hash. */
export function acceptanceCodeHash(secret: string, pendingId: string, code: string): string {
  if (Buffer.byteLength(secret) < 32)
    throw new Error('Acceptance secret is not configured securely');
  if (!/^\d{6}$/.test(code)) throw new Error('Code must have six digits');
  return createHmac('sha256', secret)
    .update(pendingId + '\0' + code)
    .digest('hex');
}
export function acceptanceCodeMatches(
  secret: string,
  pendingId: string,
  code: string,
  expectedHash: string,
): boolean {
  if (!/^\d{6}$/.test(code) || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  return timingSafeEqual(
    Buffer.from(acceptanceCodeHash(secret, pendingId, code), 'hex'),
    Buffer.from(expectedHash, 'hex'),
  );
}
export function idempotencyHash(key: string | undefined, operation: 'begin' | 'confirm'): string {
  if (!key || key.length > 200 || key.trim().length === 0)
    throw new Error('Idempotency-Key is required (1–200 characters)');
  return sha256(operation + '\0' + key);
}
