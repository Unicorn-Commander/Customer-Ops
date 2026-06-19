/**
 * A minimal, dependency-free RFC-9562 UUID v7 generator.
 *
 * WHY LOCAL (not the `uuid` package): the suite's canonical workspace id is a
 * uuidv7 (SUITE-IDENTITY §4 — the `current_workspace_id()` format + the existing
 * `DEFAULT_WORKSPACE_FALLBACK`), but the pinned `uuid@9` exposes only v1/v3/v4/v5
 * — it has no `v7`, and its `validate`/`version` actively REJECT a v7 layout. So
 * we mint v7 ourselves, in exactly the canonical lowercase 8-4-4-4-12 shape the
 * DB column + `current_workspace_id()` expect.
 *
 * Layout (RFC 9562 §5.7): 48-bit big-endian Unix-millisecond timestamp, the
 * version nibble pinned to `7`, the variant bits pinned to `10` (`8|9|a|b`), and
 * 74 random bits filling the rest. The leading timestamp makes the ids
 * time-sortable (the property the suite relies on for v7 over v4).
 *
 * This is ONLY the local fallback path: when uc-registry is reachable, Customer-
 * Ops takes the id uc-registry mints (Customer-Ops never authoritatively mints a
 * workspace id — SUITE-IDENTITY §0.1). This generator is what keeps self-serve
 * signup working (degrade-clean) when UC_REGISTRY_URL is unset/unreachable.
 */

import { randomBytes } from 'crypto';

/** Canonical lowercase v7 UUID: 8-4-4-4-12, version nibble 7, variant 8|9|a|b. */
export const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Generate a fresh RFC-9562 UUID v7 string (canonical lowercase form).
 *
 * @param now millisecond Unix timestamp to embed; defaults to `Date.now()`.
 *            Injectable so tests can pin the timestamp prefix deterministically.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 48-bit big-endian millisecond timestamp in bytes 0..5. BigInt keeps the
  // full 48 bits exact (a plain `>> 40` would overflow the 32-bit asm path).
  const ms = BigInt(Math.trunc(now));
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  // Pin the version (high nibble of byte 6 -> 0b0111) and the variant (top two
  // bits of byte 8 -> 0b10); the remaining bits stay random.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** True iff `value` is a canonical-form UUID v7 string. */
export function isUuidV7(value: string | null | undefined): boolean {
  return typeof value === 'string' && UUID_V7_REGEX.test(value);
}
