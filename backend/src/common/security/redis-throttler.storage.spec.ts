import { RedisThrottlerStorage } from './redis-throttler.storage';
import { RedisService } from '../redis/redis.service';

describe('RedisThrottlerStorage', () => {
  it('increments a shared fixed-window counter via Redis MULTI', async () => {
    // A MULTI whose exec() returns [incrResult, pttlResult]. First hit: incr=1.
    const chain = {
      incr: jest.fn().mockReturnThis(),
      pTTL: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([1, -1]),
    };
    const pExpire = jest.fn().mockResolvedValue(1);
    const client = { multi: () => chain, pExpire };
    const storage = new RedisThrottlerStorage({ client } as unknown as RedisService);

    const rec = await storage.increment('user:1', 60_000);
    expect(rec.totalHits).toBe(1);
    // First hit (or no ttl) (re)applies the window TTL.
    expect(pExpire).toHaveBeenCalledWith('throttle:user:1', 60_000);
    expect(rec.timeToExpire).toBe(60); // ceil(60000/1000)
  });

  it('does not re-apply TTL on a subsequent hit within the window', async () => {
    const chain = {
      incr: jest.fn().mockReturnThis(),
      pTTL: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([2, 40_000]), // 2nd hit, 40s left
    };
    const pExpire = jest.fn();
    const client = { multi: () => chain, pExpire };
    const storage = new RedisThrottlerStorage({ client } as unknown as RedisService);

    const rec = await storage.increment('user:1', 60_000);
    expect(rec.totalHits).toBe(2);
    expect(rec.timeToExpire).toBe(40);
    expect(pExpire).not.toHaveBeenCalled();
  });

  it('falls back to an in-process window when Redis errors', async () => {
    const client = {
      multi: () => ({
        incr: jest.fn().mockReturnThis(),
        pTTL: jest.fn().mockReturnThis(),
        exec: jest.fn().mockRejectedValue(new Error('redis down')),
      }),
      pExpire: jest.fn(),
    };
    const storage = new RedisThrottlerStorage({ client } as unknown as RedisService);

    expect((await storage.increment('k', 60_000)).totalHits).toBe(1);
    expect((await storage.increment('k', 60_000)).totalHits).toBe(2);
  });

  it('uses the in-process window when no Redis client is configured', async () => {
    const storage = new RedisThrottlerStorage({ client: null } as unknown as RedisService);
    expect((await storage.increment('k', 60_000)).totalHits).toBe(1);
    expect((await storage.increment('k', 60_000)).totalHits).toBe(2);
  });
});
