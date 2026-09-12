/**
 * The A10 binding cookie, relayed.
 *
 * The share page is a React Server Component and cannot set a cookie, so the
 * rendered document asks for its binding from the browser once on load. This
 * handler forwards that to Customer-Ops and passes the `Set-Cookie` back, which
 * is what makes the acceptance POSTs that follow acceptable to the API.
 */

import { forwardToApi } from '@/lib/quotes/proxy';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  return forwardToApi(req, token, 'bind', { method: 'GET' });
}
