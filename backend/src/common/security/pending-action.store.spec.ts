import { PendingActionStore } from './pending-action.store';
import { RedisService } from '../redis/redis.service';

function memoryStore(): PendingActionStore {
  return new PendingActionStore({ client: null } as unknown as RedisService);
}

interface Action {
  id: string;
  kind: string;
}

describe('PendingActionStore (in-memory fallback)', () => {
  it('put then take returns the value exactly once (single-use)', async () => {
    const store = memoryStore();
    await store.put<Action>('ns', 'a1', { id: 'a1', kind: 'note' }, 60_000);

    expect(await store.take<Action>('ns', 'a1')).toEqual({ id: 'a1', kind: 'note' });
    // Consumed — a second take (e.g. a racing confirm) gets null.
    expect(await store.take<Action>('ns', 'a1')).toBeNull();
  });

  it('take of an unknown id returns null', async () => {
    const store = memoryStore();
    expect(await store.take('ns', 'missing')).toBeNull();
  });

  it('expires an entry after its TTL', async () => {
    jest.useFakeTimers();
    try {
      const store = memoryStore();
      await store.put('ns', 'a1', { id: 'a1', kind: 'note' }, 1_000);
      jest.advanceTimersByTime(1_500);
      expect(await store.take('ns', 'a1')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses Redis GETDEL for an atomic single-use take when a client is present', async () => {
    const stored = JSON.stringify({ id: 'a1', kind: 'note' });
    const set = jest.fn().mockResolvedValue('OK');
    const getDel = jest
      .fn()
      .mockResolvedValueOnce(stored) // first take returns the value
      .mockResolvedValueOnce(null); // second take: already deleted
    const store = new PendingActionStore({ client: { set, getDel } } as unknown as RedisService);

    await store.put('ns', 'a1', { id: 'a1', kind: 'note' }, 60_000);
    expect(set).toHaveBeenCalledWith('ns:a1', stored, { PX: 60_000 });
    expect(await store.take<Action>('ns', 'a1')).toEqual({ id: 'a1', kind: 'note' });
    expect(await store.take<Action>('ns', 'a1')).toBeNull();
  });
});
