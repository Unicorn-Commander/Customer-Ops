import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { TokenCipher } from './token-cipher';

/**
 * TokenCipher — AES-256-GCM round-trip, tamper-detection, and the fail-closed
 * boot guard. No DB, no MSAL: this is pure node `crypto`. The security contract
 * verified here is load-bearing for the whole connector — a refresh token is a
 * bearer credential to the user's mailbox, so it must encrypt/decrypt cleanly,
 * reject tampering, and NEVER start with the connector live but no key.
 */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

/** A valid base64 32-byte key (what `openssl rand -base64 32` produces). */
const KEY_B64 = randomBytes(32).toString('base64');

describe('TokenCipher', () => {
  describe('round-trip', () => {
    const cipher = new TokenCipher(makeConfig({ M365_CLIENT_ID: 'app-1', M365_TOKEN_ENC_KEY: KEY_B64 }));

    it('encrypts then decrypts back to the original plaintext', () => {
      const secret = 'm365-refresh-token-0.AQUAxyz._very_long_opaque_value-1234567890';
      const blob = cipher.encrypt(secret);
      expect(cipher.decrypt(blob)).toBe(secret);
    });

    it('produces iv:authTag:ciphertext (3 base64 segments) and never embeds the plaintext', () => {
      const secret = 'super-secret-token';
      const blob = cipher.encrypt(secret);
      const parts = blob.split(':');
      expect(parts).toHaveLength(3);
      // The ciphertext is opaque — the plaintext must not appear anywhere in the blob.
      expect(blob).not.toContain(secret);
      // Each segment is valid base64.
      for (const p of parts) expect(Buffer.from(p, 'base64').length).toBeGreaterThan(0);
    });

    it('uses a fresh IV per call (same plaintext → different ciphertext)', () => {
      const secret = 'same-input';
      const a = cipher.encrypt(secret);
      const b = cipher.encrypt(secret);
      expect(a).not.toBe(b);
      // …but both still decrypt to the same plaintext.
      expect(cipher.decrypt(a)).toBe(secret);
      expect(cipher.decrypt(b)).toBe(secret);
    });

    it('round-trips unicode + empty string', () => {
      expect(cipher.decrypt(cipher.encrypt(''))).toBe('');
      const u = 'tøken—✓—résumé';
      expect(cipher.decrypt(cipher.encrypt(u))).toBe(u);
    });
  });

  describe('tamper detection (GCM auth tag)', () => {
    const cipher = new TokenCipher(makeConfig({ M365_CLIENT_ID: 'app-1', M365_TOKEN_ENC_KEY: KEY_B64 }));

    it('throws when the ciphertext is flipped', () => {
      const blob = cipher.encrypt('token');
      const [iv, tag, ct] = blob.split(':');
      // Corrupt the ciphertext segment (re-base64 a mutated buffer).
      const buf = Buffer.from(ct, 'base64');
      buf[0] ^= 0xff;
      const tampered = `${iv}:${tag}:${buf.toString('base64')}`;
      expect(() => cipher.decrypt(tampered)).toThrow();
    });

    it('throws when the auth tag is wrong', () => {
      const blob = cipher.encrypt('token');
      const [iv, , ct] = blob.split(':');
      const fakeTag = randomBytes(16).toString('base64');
      expect(() => cipher.decrypt(`${iv}:${fakeTag}:${ct}`)).toThrow();
    });

    it('throws on a malformed blob (wrong segment count / lengths)', () => {
      expect(() => cipher.decrypt('not-a-valid-blob')).toThrow();
      expect(() => cipher.decrypt('aaaa:bbbb')).toThrow();
      // Right shape, but IV/tag lengths are wrong.
      expect(() => cipher.decrypt('AAAA:BBBB:CCCC')).toThrow();
    });

    it('a different key cannot decrypt another key’s ciphertext', () => {
      const other = new TokenCipher(
        makeConfig({ M365_CLIENT_ID: 'app-1', M365_TOKEN_ENC_KEY: randomBytes(32).toString('base64') }),
      );
      const blob = cipher.encrypt('token');
      expect(() => other.decrypt(blob)).toThrow();
    });
  });

  describe('fail-closed boot guard', () => {
    it('THROWS when M365_CLIENT_ID is set but M365_TOKEN_ENC_KEY is missing', () => {
      expect(() => new TokenCipher(makeConfig({ M365_CLIENT_ID: 'app-1' }))).toThrow(
        /M365_TOKEN_ENC_KEY is missing/,
      );
    });

    it('THROWS when the key is the wrong length (not 32 bytes)', () => {
      const short = Buffer.from('too-short').toString('base64');
      expect(() => new TokenCipher(makeConfig({ M365_CLIENT_ID: 'app-1', M365_TOKEN_ENC_KEY: short }))).toThrow(
        /32 bytes/,
      );
    });

    it('constructs INERT when the connector is dormant (no M365_CLIENT_ID, no key)', () => {
      const cipher = new TokenCipher(makeConfig({}));
      expect(cipher.isReady).toBe(false);
      // Calling encrypt/decrypt while dormant throws (nothing should call them).
      expect(() => cipher.encrypt('x')).toThrow(/not configured/);
      expect(() => cipher.decrypt('a:b:c')).toThrow(/not configured/);
    });

    it('isReady is true once a valid key is loaded', () => {
      const cipher = new TokenCipher(makeConfig({ M365_CLIENT_ID: 'app-1', M365_TOKEN_ENC_KEY: KEY_B64 }));
      expect(cipher.isReady).toBe(true);
    });
  });
});
