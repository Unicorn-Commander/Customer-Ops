import { generatePat, hashPat, verifyPat, isPatToken } from './pat.util';
import { PAT_PREFIX } from './pat.constants';

describe('pat.util', () => {
  it('generatePat mints a co_pat_-prefixed, high-entropy, unique token + a matching hash', async () => {
    const a = generatePat();
    const b = generatePat();
    expect(a.plaintext.startsWith(PAT_PREFIX)).toBe(true);
    expect(a.plaintext.length).toBeGreaterThan(PAT_PREFIX.length + 30);
    expect(a.plaintext).not.toEqual(b.plaintext); // unique random suffix
    const hash = await a.hash;
    expect(hash).not.toEqual(a.plaintext); // stored hash is never the plaintext
    expect(await verifyPat(a.plaintext, hash)).toBe(true);
    expect(await verifyPat(b.plaintext, hash)).toBe(false);
  });

  it('hashPat + verifyPat round-trip; a wrong token fails', async () => {
    const hash = await hashPat('co_pat_secret-value');
    expect(await verifyPat('co_pat_secret-value', hash)).toBe(true);
    expect(await verifyPat('co_pat_wrong', hash)).toBe(false);
  });

  it('verifyPat is null/empty-safe (never throws)', async () => {
    expect(await verifyPat('', 'x')).toBe(false);
    expect(await verifyPat('co_pat_x', '')).toBe(false);
  });

  it('isPatToken only accepts co_pat_-prefixed strings', () => {
    expect(isPatToken('co_pat_abc')).toBe(true);
    expect(isPatToken('eyJhbGciOi...')).toBe(false); // a JWT
    expect(isPatToken(undefined)).toBe(false);
    expect(isPatToken(123)).toBe(false);
  });
});
