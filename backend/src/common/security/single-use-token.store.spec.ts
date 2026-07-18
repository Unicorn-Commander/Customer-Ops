import { SingleUseTokenStore } from './single-use-token.store';
import { RedisService } from '../redis/redis.service';

/** A RedisService whose `.client` is null exercises the in-process fallback. */
function memoryStore(): SingleUseTokenStore {
  return new SingleUseTokenStore({ client: null } as unknown as RedisService);
}

describe('SingleUseTokenStore (in-memory fallback)', () => {
  it('returns true on first use and false on replay', async () => {
    const store = memoryStore();
    expect(await store.consume('ns', 'nonce-1', 600)).toBe(true);
    expect(await store.consume('ns', 'nonce-1', 600)).toBe(false);
    expect(await store.consume('ns', 'nonce-1', 600)).toBe(false);
  });

  it('isolates ids and namespaces', async () => {
    const store = memoryStore();
    expect(await store.consume('a', 'x', 600)).toBe(true);
    expect(await store.consume('a', 'y', 600)).toBe(true); // different id
    expect(await store.consume('b', 'x', 600)).toBe(true); // different namespace
  });

  it('lets a token be re-consumed once its TTL has elapsed (self-pruning)', async () => {
    jest.useFakeTimers();
    try {
      const store = memoryStore();
      expect(await store.consume('ns', 'z', 1)).toBe(true); // 1s ttl
      expect(await store.consume('ns', 'z', 1)).toBe(false); // still within ttl
      jest.advanceTimersByTime(1_500); // past ttl
      expect(await store.consume('ns', 'z', 1)).toBe(true); // pruned → first use again
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses SET NX EX against Redis when a client is present', async () => {
    const set = jest
      .fn()
      .mockResolvedValueOnce('OK') // first use
      .mockResolvedValueOnce(null); // replay (NX collision)
    const store = new SingleUseTokenStore({ client: { set } } as unknown as RedisService);

    expect(await store.consume('ns', 'n', 600)).toBe(true);
    expect(await store.consume('ns', 'n', 600)).toBe(false);
    expect(set).toHaveBeenCalledWith('ns:n', '1', { NX: true, EX: 600 });
  });

  it('falls back to the in-memory guard when Redis throws', async () => {
    const set = jest.fn().mockRejectedValue(new Error('redis down'));
    const store = new SingleUseTokenStore({ client: { set } } as unknown as RedisService);
    // Still single-use within the replica despite the Redis error.
    expect(await store.consume('ns', 'n', 600)).toBe(true);
    expect(await store.consume('ns', 'n', 600)).toBe(false);
  });
});
