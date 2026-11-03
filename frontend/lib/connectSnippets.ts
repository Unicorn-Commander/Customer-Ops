/**
 * Copy-paste text for the Customer-Ops "Connect your AI" panel.
 *
 * Token variants deliberately contain only the visible prefix placeholder. A
 * PAT is shown once by the token card and is never inserted into this panel.
 */

export const CONNECT_TABS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-desktop', label: 'Claude Desktop / claude.ai' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'other', label: 'Cursor / Codex / other' },
] as const;

export type ConnectTabId = (typeof CONNECT_TABS)[number]['id'];

export const TOKEN_PLACEHOLDER = 'co_pat_…';

export function claudeCodeOauthCommand(url: string): string {
  return `claude mcp add --transport http customer-ops ${url}`;
}

export function claudeCodeTokenCommand(url: string): string {
  return `claude mcp add --transport http customer-ops ${url} \\\n  --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;
}

export function mcpJsonSnippet(url: string, withToken: boolean): string {
  const server: {
    type: 'http';
    url: string;
    headers?: { Authorization: string };
  } = {
    type: 'http',
    url,
  };

  if (withToken) {
    server.headers = { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` };
  }

  return JSON.stringify({ mcpServers: { 'customer-ops': server } }, null, 2);
}
