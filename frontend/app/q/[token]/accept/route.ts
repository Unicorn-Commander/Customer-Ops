/**
 * Step one of acceptance (A1): the form posts here, the API stores a pending
 * acceptance and emails a six-digit code. 202 on success; the API's own
 * problem+json (superseded, expired, not-a-recipient, cookie-required) passes
 * straight through to the document's script, which turns the `code` into a
 * sentence a client can act on.
 */

import { forwardToApi } from '@/lib/quotes/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  return forwardToApi(req, token, 'document/accept', { method: 'POST' });
}
