import { ExecutionContext } from '@nestjs/common';
import { FriendlyThrottlerGuard } from './friendly-throttler.guard';

/**
 * Pins the humane 429 message.
 *
 * FriendlyThrottlerGuard changes ONLY the rate-limit error text (limiting
 * behavior is inherited from the stock ThrottlerGuard). The default message is
 * the terse, internals-leaking 'ThrottlerException: Too Many Requests'; ours
 * must read like guidance and surface the retry window when known. This message
 * becomes the `detail` of the RFC-7807 429 body via the global filter.
 *
 * getErrorMessage is `protected`; we exercise it via a thin subclass that widens
 * it to public (the standard Nest pattern for testing a protected guard hook).
 */
class TestableGuard extends FriendlyThrottlerGuard {
  public message(detail: { timeToExpire?: number }): Promise<string> {
    return this.getErrorMessage({} as ExecutionContext, detail);
  }
}

// The guard's superclass needs (options, storage, reflector); none are touched
// by getErrorMessage, so undefineds are fine for this unit.
function makeGuard(): TestableGuard {
  return new TestableGuard(undefined as any, undefined as any, undefined as any);
}

describe('FriendlyThrottlerGuard — humane 429 message', () => {
  it('includes a concrete retry-in hint when the reset window is known', async () => {
    const msg = await makeGuard().message({ timeToExpire: 42 });
    expect(msg).toContain('Rate limit exceeded');
    expect(msg).toContain('Retry in 42s.');
    // Never leak the raw exception class name.
    expect(msg).not.toContain('ThrottlerException');
  });

  it('degrades to a soft retry hint when the window is unknown', async () => {
    const msg = await makeGuard().message({});
    expect(msg).toContain('Rate limit exceeded');
    expect(msg).toContain('Please retry shortly.');
  });

  it('treats a non-positive window as unknown (no negative retry hint)', async () => {
    const msg = await makeGuard().message({ timeToExpire: 0 });
    expect(msg).toContain('Please retry shortly.');
    expect(msg).not.toContain('Retry in 0s');
  });
});
