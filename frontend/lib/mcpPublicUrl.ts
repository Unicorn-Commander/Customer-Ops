/**
 * Build the public MCP endpoint for the frontend's configured API ring.
 *
 * Customer-Ops serves MCP at /api/v1/mcp. The host comes from the existing
 * NEXT_PUBLIC_API_URL value through API_BASE; the page origin fills in when the
 * app uses its same-origin /api/v1 default. No ring hostname belongs here.
 */
export function mcpUrlFromApiBase(apiBase: string, pageOrigin?: string | null): string {
  const base = apiBase.trim();

  if (/^https?:\/\//i.test(base)) {
    try {
      return `${new URL(base).origin}/api/v1/mcp`;
    } catch {
      // A malformed public value falls through to the browser origin below.
    }
  }

  const origin = (pageOrigin ?? '').trim().replace(/\/+$/, '');
  return origin ? `${origin}/api/v1/mcp` : '/api/v1/mcp';
}
