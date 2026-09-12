import { randomBytes } from 'crypto';
import {
  acceptanceCodeHash,
  acceptanceCodeMatches,
  idempotencyHash,
  newAcceptanceCode,
  newShareToken,
  sha256,
} from './quote-secrets';
it('mints a 32-byte capability and stores only its SHA-256 representation', () => {
  const a = newShareToken(),
    b = newShareToken();
  expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
  expect(a.tokenHash).toBe(sha256(a.token));
  expect(a.token).not.toBe(b.token);
});
it('binds the keyed six-digit verifier to exactly one pending acceptance', () => {
  const secret = randomBytes(32).toString('hex'),
    code = newAcceptanceCode();
  expect(code).toMatch(/^\d{6}$/);
  const hash = acceptanceCodeHash(secret, 'pending-a', code);
  expect(acceptanceCodeMatches(secret, 'pending-a', code, hash)).toBe(true);
  expect(acceptanceCodeMatches(secret, 'pending-b', code, hash)).toBe(false);
  expect(acceptanceCodeMatches(secret, 'pending-a', 'not-a-code', hash)).toBe(false);
  expect(() => acceptanceCodeHash('short', 'pending-a', code)).toThrow(/secret/);
});
it('requires bounded idempotency keys and separates begin from confirm', () => {
  expect(() => idempotencyHash(undefined, 'begin')).toThrow(/required/);
  expect(() => idempotencyHash('a'.repeat(201), 'begin')).toThrow(/required/);
  expect(idempotencyHash('same', 'begin')).not.toBe(idempotencyHash('same', 'confirm'));
});
