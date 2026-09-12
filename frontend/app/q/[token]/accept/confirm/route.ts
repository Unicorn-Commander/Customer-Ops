/**
 * Step two of acceptance (A1): the six-digit code commits it. Five wrong codes
 * void the pending acceptance upstream; the response carries `attempts_left`
 * so the document can say how many are left.
 */

import { forwardToApi } from '@/lib/quotes/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  return forwardToApi(req, token, 'document/accept/confirm', { method: 'POST' });
}
