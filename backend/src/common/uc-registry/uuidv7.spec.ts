import { UUID_V7_REGEX, isUuidV7, uuidv7 } from './uuidv7';

/**
 * The local uuidv7 generator is the degrade-clean fallback for self-serve
 * workspace-id minting (UC_REGISTRY_URL unset/unreachable). It MUST emit a
 * canonical-shape RFC-9562 v7 (so the DB column + Postgres current_workspace_id()
 * accept it), the same shape as the suite's DEFAULT_WORKSPACE_FALLBACK constant.
 * NOTE: the pinned uuid@9 package's own validate()/version() reject v7 entirely,
 * which is exactly why we generate + validate it ourselves here.
 */
describe('uuidv7', () => {
  it('emits a canonical lowercase v7 UUID (version nibble 7, RFC variant)', () => {
    for (let i = 0; i < 500; i++) {
      const u = uuidv7();
      expect(u).toMatch(UUID_V7_REGEX);
      expect(u[14]).toBe('7'); // version nibble
      expect('89ab').toContain(u[19]); // variant nibble
    }
  });

  it('embeds the supplied millisecond timestamp big-endian in the first 48 bits', () => {
    // 0x0190a000_7e57 is the prefix of the suite's bootstrap workspace const.
    const ms = 0x0190a0007e57;
    const u = uuidv7(ms);
    const tsHex = u.replace(/-/g, '').slice(0, 12);
    expect(tsHex).toBe('0190a0007e57');
  });

  it('is time-sortable: a later timestamp sorts strictly after an earlier one', () => {
    const early = uuidv7(1_000_000_000_000);
    const late = uuidv7(2_000_000_000_000);
    expect(late > early).toBe(true);
  });

  it('is effectively unique across a tight loop', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(uuidv7());
    expect(seen.size).toBe(10_000);
  });

  it('isUuidV7 accepts generated ids + the suite bootstrap const, rejects junk', () => {
    expect(isUuidV7(uuidv7())).toBe(true);
    // The DEFAULT_WORKSPACE_FALLBACK shape (proves format consistency w/ the suite).
    expect(isUuidV7('0190a000-7e57-7000-8000-00000000c007')).toBe(true);
    expect(isUuidV7('not-a-uuid')).toBe(false);
    expect(isUuidV7('0190a000-7e57-4000-8000-00000000c007')).toBe(false); // v4, wrong version
    expect(isUuidV7(null)).toBe(false);
    expect(isUuidV7(undefined)).toBe(false);
  });
});
