import { Request, Response } from 'express';
import {
  RequestContextMiddleware,
  RequestWithId,
  REQUEST_ID_HEADER,
} from './request-context.middleware';
import { entitlementRequestScope } from '../workspace/entitlement-request-scope';

/**
 * Pins request-id correlation.
 *
 * Every request must carry an id (the join key between a log line, an RFC-7807
 * body, and an error-tracker event). We honor a sane upstream id (Traefik) but
 * reject a hostile one — the value lands in logs + a response header, so a
 * too-long / wrong-charset id (log-injection / header-splitting vector) must be
 * replaced with a fresh uuid, never echoed.
 */
function makeReq(headers: Record<string, string | string[] | undefined> = {}): RequestWithId {
  return { headers } as unknown as RequestWithId;
}
function makeRes(): { res: Response; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
  } as unknown as Response;
  return { res, headers };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('RequestContextMiddleware', () => {
  const mw = new RequestContextMiddleware();

  it('mints a uuid + sets X-Request-Id when no inbound id is present', () => {
    const req = makeReq();
    const { res, headers } = makeRes();
    const next = jest.fn();

    mw.use(req, res, next);

    expect(req.id).toMatch(UUID_RE);
    expect(headers['X-Request-Id']).toBe(req.id);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('honors a sane inbound correlation id', () => {
    const req = makeReq({ [REQUEST_ID_HEADER]: 'edge-01HZX9ABCDEF' });
    const { res, headers } = makeRes();

    mw.use(req, res, jest.fn());

    expect(req.id).toBe('edge-01HZX9ABCDEF');
    expect(headers['X-Request-Id']).toBe('edge-01HZX9ABCDEF');
  });

  it('rejects a hostile inbound id (newline / overlong) and mints a fresh one', () => {
    const evil = makeReq({ [REQUEST_ID_HEADER]: 'abc\r\nSet-Cookie: x=1' });
    mw.use(evil, makeRes().res, jest.fn());
    expect(evil.id).toMatch(UUID_RE); // not the injected value

    const tooLong = makeReq({ [REQUEST_ID_HEADER]: 'a'.repeat(200) });
    mw.use(tooLong, makeRes().res, jest.fn());
    expect(tooLong.id).toMatch(UUID_RE);
  });

  it('takes the first value of a duplicated header', () => {
    const req = makeReq({ [REQUEST_ID_HEADER]: ['first-id', 'second-id'] });
    mw.use(req, makeRes().res, jest.fn());
    expect(req.id).toBe('first-id');
  });

  /**
   * This middleware is ALSO where the per-request entitlement memo scope is
   * opened — chosen because it already runs before guards/interceptors on every
   * route, so the PAT auth chokepoint and every `effectiveEntitlements` call site
   * land inside one scope. Without it the resolver's memo never engages and one
   * inbound request fans out into a dozen outbound entitlement fetches. Pinned
   * here so deleting the wiring cannot pass silently.
   */
  describe('opens the per-request entitlement memo scope', () => {
    it('the downstream handler runs INSIDE a scope', () => {
      let seen: unknown;
      mw.use(makeReq(), makeRes().res, () => {
        seen = entitlementRequestScope();
      });
      expect(seen).toBeInstanceOf(Map);
    });

    it('each request gets its OWN scope (no cross-request carry-over)', () => {
      const scopes: unknown[] = [];
      mw.use(makeReq(), makeRes().res, () => scopes.push(entitlementRequestScope()));
      mw.use(makeReq(), makeRes().res, () => scopes.push(entitlementRequestScope()));
      expect(scopes[0]).not.toBe(scopes[1]);
    });

    it('outside the middleware there is no scope at all', () => {
      expect(entitlementRequestScope()).toBeUndefined();
    });

    it('the scope survives an async continuation of the handler', async () => {
      let seen: unknown;
      await new Promise<void>((done) => {
        mw.use(makeReq(), makeRes().res, () => {
          void (async () => {
            await Promise.resolve();
            seen = entitlementRequestScope();
            done();
          })();
        });
      });
      expect(seen).toBeInstanceOf(Map);
    });
  });
});
