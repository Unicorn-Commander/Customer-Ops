import { graphKeyFor, isValidWorkspaceId, GRAPH_KEY_PREFIX } from './graph-key';

/**
 * graphKeyFor is THE tenancy chokepoint — the only place a FalkorDB graph key is
 * built. These pin the two things that matter: a VALID uuid yields the canonical
 * `cust_ops:ws:<id>` key, and anything that could collapse tenants together
 * (empty, whitespace, a slug, an injection attempt) throws (fail-closed) rather
 * than silently producing a shared key.
 */
describe('graphKeyFor (the graph-key chokepoint)', () => {
  const VALID = '0190a000-7e57-7000-8000-00000000c007'; // a uuidv7-shaped id

  describe('valid workspace ids', () => {
    it('builds cust_ops:ws:<id> for a canonical uuid', () => {
      expect(graphKeyFor(VALID)).toBe(`${GRAPH_KEY_PREFIX}${VALID}`);
      expect(graphKeyFor(VALID)).toBe(`cust_ops:ws:${VALID}`);
    });

    it('lower-cases the id so the key is canonical regardless of caller casing', () => {
      const upper = VALID.toUpperCase();
      expect(graphKeyFor(upper)).toBe(`${GRAPH_KEY_PREFIX}${VALID}`);
      // Same workspace, different casing → same graph key (no tenant split).
      expect(graphKeyFor(upper)).toBe(graphKeyFor(VALID));
    });

    it('trims surrounding whitespace', () => {
      expect(graphKeyFor(`  ${VALID}  `)).toBe(`${GRAPH_KEY_PREFIX}${VALID}`);
    });

    it('accepts a uuidv4-shaped id (version-lenient)', () => {
      const v4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      expect(graphKeyFor(v4)).toBe(`${GRAPH_KEY_PREFIX}${v4}`);
    });
  });

  describe('invalid workspace ids (fail-closed — must throw)', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['a slug', 'acme-workspace'],
      ['a too-short hex', 'abc123'],
      ['a number-like', '12345'],
      ['a uuid missing a segment', '0190a000-7e57-7000-00000000c007'],
      ['an injection attempt', "x'}) MATCH (n) DETACH DELETE n //"],
    ])('throws on %s', (_label, bad) => {
      expect(() => graphKeyFor(bad as string)).toThrow();
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a number', 123],
      ['an object', {}],
    ])('throws on %s (non-string)', (_label, bad) => {
      expect(() => graphKeyFor(bad as unknown as string)).toThrow();
    });

    it('never echoes the raw (possibly-malicious) value in the error message', () => {
      const payload = "deadbeef'}) DETACH DELETE n //";
      expect(() => graphKeyFor(payload)).toThrow(/not a valid uuid/);
      try {
        graphKeyFor(payload);
      } catch (err) {
        expect((err as Error).message).not.toContain('DETACH DELETE');
      }
    });
  });

  describe('isValidWorkspaceId', () => {
    it('is true for a valid uuid and false otherwise', () => {
      expect(isValidWorkspaceId(VALID)).toBe(true);
      expect(isValidWorkspaceId('  ' + VALID + '  ')).toBe(true);
      expect(isValidWorkspaceId('')).toBe(false);
      expect(isValidWorkspaceId('not-a-uuid')).toBe(false);
      expect(isValidWorkspaceId(null)).toBe(false);
      expect(isValidWorkspaceId(undefined)).toBe(false);
      expect(isValidWorkspaceId(42)).toBe(false);
    });
  });
});
