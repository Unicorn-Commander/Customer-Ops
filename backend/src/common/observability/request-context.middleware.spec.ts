import { Request, Response } from 'express';
import {
  RequestContextMiddleware,
  RequestWithId,
  REQUEST_ID_HEADER,
} from './request-context.middleware';

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
});
