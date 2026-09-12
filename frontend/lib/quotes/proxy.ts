/**
 * The share page's thin edge to Customer-Ops.
 *
 * Acceptance is the API's business, not the renderer's: the pending record,
 * the six-digit code, the attempt counter, the recipient gate and the
 * supersede/expiry re-checks all live behind `/api/v1/public/quotes/:token/…`.
 * These handlers forward the request with its binding cookie and hand the
 * answer back unchanged, so the browser talks to one origin and the server
 * keeps the only copy of the rules.
 *
 * Nothing here inspects or rewrites a body — an RFC-7807 problem from the API
 * reaches the document's script exactly as the API wrote it, including the
 * `code` the script maps to a human sentence.
 */

import { NextResponse } from 'next/server';

import { apiBase } from './source';

const TOKEN_RE = /^[A-Za-z0-9_-]{4,128}$/;
/** Headers worth carrying upstream; everything else is dropped on purpose. */
const FORWARD = ['content-type', 'accept', 'cookie', 'idempotency-key', 'user-agent'];

function problem(status: number, code: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title: code, status, detail, code },
    { status, headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' } },
  );
}

/** Forward one public-quote request upstream and return the API's own answer. */
export async function forwardToApi(
  req: Request,
  token: string,
  path: string,
  init: { method: 'GET' | 'POST' },
): Promise<Response> {
  if (!TOKEN_RE.test(token)) return problem(404, 'QUOTE_NOT_FOUND', 'No quote at this link.');
  const base = apiBase();
  if (!base) {
    return problem(
      503,
      'API_UNCONFIGURED',
      'This deployment has no Customer-Ops API configured, so acceptance cannot be recorded. Set QUOTES_RENDER_API_URL.',
    );
  }

  const headers = new Headers();
  for (const name of FORWARD) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) headers.set('X-Forwarded-For', forwardedFor);

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/public/quotes/${encodeURIComponent(token)}/${path}`, {
      method: init.method,
      headers,
      body: init.method === 'POST' ? await req.text() : undefined,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return problem(502, 'API_UNREACHABLE', 'Could not reach the quote service. Try again in a moment.');
  }

  const out = new Headers();
  for (const name of ['content-type', 'content-disposition', 'set-cookie']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set('Cache-Control', 'no-store');
  out.set('X-Robots-Tag', 'noindex, nofollow');
  return new NextResponse(upstream.body, { status: upstream.status, headers: out });
}
