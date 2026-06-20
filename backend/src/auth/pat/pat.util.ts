import { randomBytes } from 'crypto';
// Pure-JS bcrypt (bcrypt-format hashes, no native build) — CO's node:20-alpine
// image carries no compiler toolchain, and CO has no other native deps.
import * as bcrypt from 'bcryptjs';
import { PAT_BCRYPT_COST, PAT_PREFIX, PAT_TOKEN_BYTES } from './pat.constants';

/**
 * Personal Access Token primitives.
 *
 * `generatePat` returns the plaintext token (with prefix) so the caller can
 * surface it to the user exactly once, plus a promise that resolves to the
 * bcrypt hash to persist (started eagerly). `verifyPat`/`isPatToken` are the
 * read-side helpers used by the auth pipeline.
 */
export interface GeneratedPat {
  plaintext: string;
  hash: Promise<string>;
}

export function generatePat(): GeneratedPat {
  const random = randomBytes(PAT_TOKEN_BYTES).toString('base64url');
  const plaintext = `${PAT_PREFIX}${random}`;
  // Kick off the hash but don't await — caller awaits when they need it.
  const hash = bcrypt.hash(plaintext, PAT_BCRYPT_COST);
  return { plaintext, hash };
}

export async function hashPat(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, PAT_BCRYPT_COST);
}

export async function verifyPat(plaintext: string, hash: string): Promise<boolean> {
  if (!plaintext || !hash) return false;
  return bcrypt.compare(plaintext, hash);
}

/**
 * Cheap prefix check used to decide whether an incoming bearer is a PAT or a JWT
 * before any expensive parsing / DB hit. Tolerant of non-string inputs so the
 * auth pipeline never throws on a malformed header.
 */
export function isPatToken(token: unknown): token is string {
  return typeof token === 'string' && token.startsWith(PAT_PREFIX);
}
