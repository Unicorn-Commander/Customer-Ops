import { ServiceUnavailableException } from '@nestjs/common';

/** Default capacity: comfortably above 60 s of control-plane calls. */
export const DEFAULT_JTI_STORE_CAPACITY = 10_000;

/**
 * Bounded, in-memory, accept-once store for provisioning token `jti`s.
 *
 * An entry is kept until its token's `exp` (plus the clock skew we allow), after
 * which the token itself is refused as expired, so the entry is no longer
 * needed. When the store is full of live entries it FAILS CLOSED (503) rather
 * than forgetting a jti that could then be replayed.
 *
 * Per process: with several replicas behind one balancer a jti is accepted once
 * per replica. The token's 60-second lifetime bounds that window.
 */
export class ProvisioningJtiStore {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly capacity = DEFAULT_JTI_STORE_CAPACITY,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.seen.size;
  }

  /**
   * Record `jti` as used until `expiresAtMs`. Returns false on a replay; throws
   * 503 when the store is full of live entries.
   */
  accept(jti: string, expiresAtMs: number): boolean {
    this.prune();
    if (this.seen.has(jti)) return false;
    if (this.seen.size >= this.capacity) {
      throw new ServiceUnavailableException('Provisioning replay store is full; retry shortly.');
    }
    this.seen.set(jti, expiresAtMs);
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [jti, exp] of this.seen) {
      if (exp <= now) this.seen.delete(jti);
    }
  }
}
