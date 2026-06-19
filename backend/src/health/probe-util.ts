/**
 * Shared helpers for the federation seam health probes (`*.client.ts` `ping()`).
 * Kept tiny + dependency-free so each client can reuse the same body-truncation
 * + classification without duplicating it.
 */

/** Read a probe response body and return a short, single-line snippet safe to
 *  put in a SeamHealth.detail (caps length, collapses whitespace). Never throws —
 *  a body that can't be read yields ''. */
export async function shortBody(res: Response, max = 200): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return '';
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
