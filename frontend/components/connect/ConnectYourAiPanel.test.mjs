import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONNECT_TABS,
  TOKEN_PLACEHOLDER,
  claudeCodeOauthCommand,
  claudeCodeTokenCommand,
  mcpJsonSnippet,
} from '../../lib/connectSnippets.ts';
import { mcpUrlFromApiBase } from '../../lib/mcpPublicUrl.ts';

const URL = 'https://customer-ops.example.com/api/v1/mcp';

describe('Connect your AI tab states', () => {
  it('offers every client tab in the shared order', () => {
    assert.deepEqual(
      CONNECT_TABS.map((tab) => tab.id),
      ['claude-code', 'claude-desktop', 'chatgpt', 'other'],
    );
    assert.deepEqual(
      CONNECT_TABS.map((tab) => tab.label),
      ['Claude Code', 'Claude Desktop / claude.ai', 'ChatGPT', 'Cursor / Codex / other'],
    );
  });

  it('builds Claude Code OAuth and token command states', () => {
    const oauth = claudeCodeOauthCommand(URL);
    assert.equal(oauth, `claude mcp add --transport http customer-ops ${URL}`);
    assert.equal(oauth.includes('Authorization'), false);
    assert.equal(oauth.includes(TOKEN_PLACEHOLDER), false);

    const token = claudeCodeTokenCommand(URL);
    assert.match(token, /claude mcp add --transport http customer-ops https:\/\/customer-ops\.example\.com\/api\/v1\/mcp/);
    assert.equal(token.includes('\n+'), false);
    assert.match(token, /--header "Authorization: Bearer co_pat_…"/);
    assert.equal(token.includes('co_pat_ABCDEF'), false);
  });

  it('builds URL-only and Authorization-header mcp.json states', () => {
    const plain = JSON.parse(mcpJsonSnippet(URL, false));
    assert.equal(plain.mcpServers['customer-ops'].type, 'http');
    assert.equal(plain.mcpServers['customer-ops'].url, URL);
    assert.equal(plain.mcpServers['customer-ops'].headers, undefined);

    const withToken = JSON.parse(mcpJsonSnippet(URL, true));
    assert.equal(withToken.mcpServers['customer-ops'].headers.Authorization, 'Bearer co_pat_…');
  });
});

describe('MCP URL from NEXT_PUBLIC_API_URL', () => {
  it('uses the configured API origin and preserves the MCP path contract', () => {
    assert.equal(
      mcpUrlFromApiBase('https://customer-ops.example.com/api/v1'),
      'https://customer-ops.example.com/api/v1/mcp',
    );
    assert.equal(
      mcpUrlFromApiBase('https://customer-ops.example.org/api/v1/'),
      'https://customer-ops.example.org/api/v1/mcp',
    );
  });

  it('uses the page origin for the same-origin frontend default', () => {
    assert.equal(
      mcpUrlFromApiBase('/api/v1', 'https://customer-ops.example.com/'),
      'https://customer-ops.example.com/api/v1/mcp',
    );
    assert.equal(mcpUrlFromApiBase('/api/v1'), '/api/v1/mcp');
  });
});
