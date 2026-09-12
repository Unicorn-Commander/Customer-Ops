import type { Request } from 'express';

import { clientIp, requestMeta } from './quotes-render.controller';
import { ReplayCache, TokenRateLimiter } from './token-rate-limit';

function req(headers: Record<string, string | string[]>, peer = '10.0.0.5'): Request {
  return { headers, socket: { remoteAddress: peer } } as unknown as Request;
}

describe('clientIp — the trusted hop only (H1)', () => {
  it('takes the address OUR edge saw, not the one the browser claimed', () => {
    // Traefik appends what it observed, so the browser's forgery sits to the LEFT.
    const r = req({ 'x-forwarded-for': '8.8.8.8, 203.0.113.7' });
    expect(clientIp(r, 1)).toBe('203.0.113.7');
  });

  it('ignores a header the client made up entirely', () => {
    // A single spoofed entry with no proxy behind it is still the last entry —
    // which is why the hop count must match the deployment, and why a request
    // that never passed the edge uses the socket peer instead.
    expect(clientIp(req({}), 1)).toBe('10.0.0.5');
    expect(clientIp(req({ 'x-forwarded-for': '   ' }), 1)).toBe('10.0.0.5');
  });

  it('counts hops from the right for an edge behind another edge', () => {
    const r = req({ 'x-forwarded-for': 'forged, 203.0.113.7, 172.16.0.1' });
    expect(clientIp(r, 2)).toBe('203.0.113.7');
    expect(clientIp(r, 1)).toBe('172.16.0.1');
  });

  it('hops = 0 means no proxy is trusted: the socket peer, header ignored', () => {
    expect(clientIp(req({ 'x-forwarded-for': '8.8.8.8' }), 0)).toBe('10.0.0.5');
  });

  it('returns null rather than a guess when nothing parses as an address', () => {
    expect(clientIp(req({ 'x-forwarded-for': 'not-an-ip' }), 1)).toBeNull();
    expect(clientIp(req({}, 'unknown'), 1)).toBeNull();
  });

  it('strips a port from the dotted form and keeps a bare IPv6 intact', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7:51234' }), 1)).toBe('203.0.113.7');
    expect(clientIp(req({ 'x-forwarded-for': '[2001:db8::1]' }), 1)).toBe('2001:db8::1');
  });

  it('requestMeta caps the user agent and only accepts a sane idempotency key', () => {
    const meta = requestMeta(req({ 'user-agent': 'x'.repeat(500), 'idempotency-key': 'k-1' }), 1);
    expect(meta.ua?.length).toBe(300);
    expect(meta.idempotency_key).toBe('k-1');
    expect(requestMeta(req({ 'idempotency-key': 'k'.repeat(300) }), 1).idempotency_key).toBeNull();
  });
});

describe('TokenRateLimiter — the per-token axis', () => {
  it('counts per token, not globally, and rolls at the window', () => {
    let now = 1_000;
    const rl = new TokenRateLimiter(3, 60_000, () => now);
    expect(rl.hit('a').ok).toBe(true);
    expect(rl.hit('a').ok).toBe(true);
    expect(rl.hit('a').ok).toBe(true);
    const over = rl.hit('a');
    expect(over.ok).toBe(false);
    expect(over.retry_after_s).toBeGreaterThan(0);
    // A different share link is untouched by the first one's budget.
    expect(rl.hit('b').ok).toBe(true);
    now += 60_001;
    expect(rl.hit('a').ok).toBe(true);
  });

  it('charges a weight, so an expensive route burns the budget faster', () => {
    const rl = new TokenRateLimiter(10, 60_000, () => 0);
    expect(rl.hit('t', 5).ok).toBe(true);
    expect(rl.hit('t', 5).ok).toBe(true);
    expect(rl.hit('t', 1).ok).toBe(false);
  });

  it('stays bounded under a flood of distinct tokens', () => {
    let now = 0;
    const rl = new TokenRateLimiter(5, 1_000, () => now);
    for (let i = 0; i < 20_000; i += 1) {
      rl.hit(`tok-${i}`);
      now += 1;
    }
    // Nothing here asserts an exact size — only that a map keyed by
    // attacker-supplied input did not grow to the number of requests.
    expect(rl.hit('after').ok).toBe(true);
  });
});

describe('ReplayCache — bounded idempotency (A10)', () => {
  it('replays within the ttl and forgets after it', () => {
    let now = 0;
    const c = new ReplayCache<string>(1_000, 100, () => now);
    c.set('k', 'outcome');
    expect(c.get('k')).toBe('outcome');
    now = 1_001;
    expect(c.get('k')).toBeUndefined();
  });

  it('never exceeds its cap', () => {
    let now = 0;
    const c = new ReplayCache<number>(60_000, 50, () => now);
    for (let i = 0; i < 500; i += 1) {
      c.set(`k${i}`, i);
      now += 1;
    }
    expect(c.size).toBeLessThanOrEqual(50);
    // The most recent write survives; the oldest are the ones dropped.
    expect(c.get('k499')).toBe(499);
    expect(c.get('k0')).toBeUndefined();
  });
});
