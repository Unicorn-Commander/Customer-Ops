import { QuotesJobsService } from './quotes-jobs.service';
import { QuotesModule } from './quotes.module';

describe('Quotes registration and background jobs', () => {
  afterEach(() => jest.useRealTimers());
  it('flag off registers no controllers/providers and starts no jobs', async () => {
    jest.useFakeTimers();
    const lifecycle = { reconcile: jest.fn(), expire: jest.fn() };
    expect(QuotesModule.register(false)).toEqual({ module: QuotesModule });
    const jobs = new QuotesJobsService({ get: () => undefined } as any, lifecycle as any);
    jobs.onModuleInit();
    await jest.advanceTimersByTimeAsync(86400000);
    expect(lifecycle.reconcile).not.toHaveBeenCalled();
    expect(lifecycle.expire).not.toHaveBeenCalled();
    jobs.onModuleDestroy();
  });
  it('runs approval observation once per minute, expiry daily, and cancels timers on teardown', async () => {
    jest.useFakeTimers();
    const lifecycle = {
      reconcile: jest.fn().mockResolvedValue(undefined),
      expire: jest.fn().mockResolvedValue(undefined),
    };
    const jobs = new QuotesJobsService({ get: () => '1' } as any, lifecycle as any);
    jobs.onModuleInit();
    await jest.advanceTimersByTimeAsync(60000);
    expect(lifecycle.reconcile).toHaveBeenCalledTimes(1);
    expect(lifecycle.expire).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(86400000 - 60000);
    expect(lifecycle.expire).toHaveBeenCalledTimes(1);
    jobs.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60000);
    expect(lifecycle.reconcile).toHaveBeenCalledTimes(1440);
  });
});
