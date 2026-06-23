/**
 * TokenCipher — AES-256-GCM at-rest encryption for Microsoft 365 OAuth tokens.
 *
 * The M365 connector stores a delegated Graph REFRESH token (and, opportunistically,
 * a short-lived access token) so the recurring contact sync can mint fresh access
 * tokens without re-prompting the user. Those tokens are bearer credentials to the
 * user's mailbox/contacts — they MUST be encrypted at rest and decryptable (so a
 * one-way bcrypt hash, the PAT pattern, is wrong here; PATs we verify, refresh
 * tokens we must replay).
 *
 * Cipher: AES-256-GCM (authenticated — a tampered ciphertext throws on decrypt
 * rather than yielding garbage). Key = base64-decoded `M365_TOKEN_ENC_KEY`, which
 * MUST be exactly 32 bytes (generate with `openssl rand -base64 32`). The wire
 * format is `iv:authTag:ciphertext`, each segment base64, so a 12-byte random IV
 * and the 16-byte GCM tag travel with every ciphertext (the IV is not secret).
 *
 * FAIL-CLOSED AT BOOT (mirrors jwt.strategy's empty-JWT_SECRET guard): when
 * M365_CLIENT_ID is set (the connector is meant to be live) but M365_TOKEN_ENC_KEY
 * is missing or the wrong length, the constructor THROWS — we never silently fall
 * back to storing plaintext or to a weak/derived key. When M365_CLIENT_ID is unset
 * (connector dormant) the cipher constructs inert: encrypt/decrypt then throw if
 * ever called, but nothing calls them, so the app boots unchanged.
 *
 * NEVER log a token or a decrypted blob. Errors here carry only structural detail
 * (length/format), never key or plaintext material.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const AUTH_TAG_BYTES = 16;

@Injectable()
export class TokenCipher {
  /** The 32-byte key, or null when the connector is dormant (no M365_CLIENT_ID). */
  private readonly key: Buffer | null;

  constructor(private readonly config: ConfigService) {
    const connectorConfigured = !!this.config.get<string>('M365_CLIENT_ID')?.trim();
    const rawKey = this.config.get<string>('M365_TOKEN_ENC_KEY')?.trim();

    if (!connectorConfigured) {
      // Connector dormant: construct inert. A real key is still honored if present
      // (so a deployment can pre-seed the key), but its absence is NOT fatal here.
      this.key = rawKey ? this.decodeKey(rawKey) : null;
      return;
    }

    // Connector configured → the key is mandatory and must be exactly 32 bytes.
    // Fail closed: a missing/short key here would otherwise force a choice between
    // crashing later or (worse) storing tokens unprotected. Neither is acceptable.
    if (!rawKey) {
      throw new Error(
        'M365_CLIENT_ID is set but M365_TOKEN_ENC_KEY is missing — refusing to start. ' +
          'Generate one with `openssl rand -base64 32` and set M365_TOKEN_ENC_KEY.',
      );
    }
    this.key = this.decodeKey(rawKey);
  }

  /** Whether a usable key is loaded (the connector can encrypt/decrypt). */
  get isReady(): boolean {
    return this.key !== null;
  }

  /**
   * Encrypt a plaintext token → `iv:authTag:ciphertext` (each segment base64).
   * A fresh random IV per call (GCM must never reuse an IV under one key).
   */
  encrypt(plaintext: string): string {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  /**
   * Decrypt an `iv:authTag:ciphertext` blob produced by `encrypt`. Throws if the
   * format is malformed OR the auth tag fails (tamper / wrong key) — a caller must
   * treat a throw as "this token is unusable", never as plaintext.
   */
  decrypt(blob: string): string {
    const key = this.requireKey();
    const parts = blob.split(':');
    if (parts.length !== 3) {
      throw new Error('TokenCipher: malformed ciphertext (expected iv:authTag:ciphertext)');
    }
    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const ciphertext = Buffer.from(parts[2], 'base64');
    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new Error('TokenCipher: malformed ciphertext (bad iv/authTag length)');
    }
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    // .final() throws 'Unsupported state or unable to authenticate data' on a bad tag.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** Decode + length-check the base64 key. Errors carry only the length, no material. */
  private decodeKey(rawKey: string): Buffer {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(rawKey, 'base64');
    } catch {
      throw new Error('M365_TOKEN_ENC_KEY is not valid base64');
    }
    if (decoded.length !== KEY_BYTES) {
      throw new Error(
        `M365_TOKEN_ENC_KEY must decode to exactly ${KEY_BYTES} bytes (got ${decoded.length}). ` +
          'Generate one with `openssl rand -base64 32`.',
      );
    }
    return decoded;
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new Error(
        'TokenCipher has no key (M365_TOKEN_ENC_KEY unset) — the M365 connector is not configured.',
      );
    }
    return this.key;
  }
}
