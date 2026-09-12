/**
 * The PDF of this quote — the SAME template the page renders, printed by the
 * API's headless Chromium. `?size=a4` switches the page size from Letter.
 * Kept on this origin so the document's links never leave the share host.
 */

import { forwardToApi } from '@/lib/quotes/proxy';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const size = new URL(req.url).searchParams.get('size') === 'a4' ? 'a4' : 'letter';
  return forwardToApi(req, token, `document.pdf?size=${size}`, { method: 'GET' });
}
