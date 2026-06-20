import { mcpToolDenial } from './mcp-access';

const WS = '0190a000-7e57-7000-8000-00000000c007';
const OTHER_WS = '0190a000-7e57-7000-8000-0000000000ff';

/** Parse the JSON detail out of a denial envelope for assertions. */
function detailOf(denial: ReturnType<typeof mcpToolDenial>) {
  expect(denial).not.toBeNull();
  expect(denial!.isError).toBe(true);
  return JSON.parse(denial!.content[0].text) as Record<string, unknown>;
}

describe('mcpToolDenial — JWT / federation callers', () => {
  it('never gates a non-PAT caller (grantedScopes null) — full RBAC', () => {
    // Even a write tool addressing another workspace is allowed for a JWT caller;
    // their membership RBAC (resolveAuthorized) is the gate, not a PAT binding.
    expect(mcpToolDenial('transition_customer_stage', { workspace_id: OTHER_WS }, null, null)).toBeNull();
    expect(mcpToolDenial('not_a_real_tool', {}, null, null)).toBeNull();
  });
});

describe('mcpToolDenial — PAT scope gate', () => {
  it('allows a tool whose required scope is held', () => {
    expect(mcpToolDenial('list_customers', {}, ['read:customers'], WS)).toBeNull();
    expect(mcpToolDenial('transition_customer_stage', {}, ['write:customers'], WS)).toBeNull();
    expect(mcpToolDenial('ingest_lead', {}, ['write:leads'], WS)).toBeNull();
    expect(mcpToolDenial('triage_customer', {}, ['run:agents'], WS)).toBeNull();
  });

  it('denies a tool whose required scope is missing, naming the scope', () => {
    const denial = mcpToolDenial('transition_customer_stage', {}, ['read:customers'], WS);
    const detail = detailOf(denial);
    expect(detail.error).toBe('scope_denied');
    expect(detail.tool).toBe('transition_customer_stage');
    expect(detail.required_scope).toBe('write:customers');
    expect(detail.granted_scopes).toEqual(['read:customers']);
  });

  it('honors write ⊇ read (a write:customers token may call a read tool)', () => {
    expect(mcpToolDenial('list_customers', {}, ['write:customers'], WS)).toBeNull();
    expect(mcpToolDenial('get_customer_360', {}, ['write:customers'], WS)).toBeNull();
  });

  it('exempts health + whoami for any PAT (MCP_TOOL_NO_SCOPE)', () => {
    expect(mcpToolDenial('health', {}, [], WS)).toBeNull();
    expect(mcpToolDenial('list_my_workspaces', {}, [], WS)).toBeNull();
  });

  it('fails CLOSED on an unmapped tool name (no scope mapping → deny)', () => {
    const denial = mcpToolDenial('exfiltrate_everything', {}, ['write:customers'], WS);
    const detail = detailOf(denial);
    expect(detail.error).toBe('scope_denied');
    expect(detail.required_scope).toContain('no scope mapping');
  });
});

describe('mcpToolDenial — PAT workspace fence', () => {
  it('allows an arg workspace_id equal to the bound workspace', () => {
    expect(mcpToolDenial('list_customers', { workspace_id: WS }, ['read:customers'], WS)).toBeNull();
  });

  it('allows omitting workspace_id (falls back to the bound workspace)', () => {
    expect(mcpToolDenial('list_customers', {}, ['read:customers'], WS)).toBeNull();
  });

  it('DENIES an arg workspace_id that escapes the PAT binding', () => {
    const denial = mcpToolDenial('list_customers', { workspace_id: OTHER_WS }, ['read:customers'], WS);
    const detail = detailOf(denial);
    expect(detail.error).toBe('workspace_denied');
    expect(detail.pat_workspace).toBe(WS);
    expect(detail.requested_workspace).toBe(OTHER_WS);
  });

  it('checks the workspace fence BEFORE the scope (a cross-ws read is still denied)', () => {
    // Even with the right scope, a cross-workspace arg is refused.
    const denial = mcpToolDenial('list_customers', { workspace_id: OTHER_WS }, ['read:customers'], WS);
    expect(detailOf(denial).error).toBe('workspace_denied');
  });

  it('ignores a blank/whitespace workspace_id arg', () => {
    expect(mcpToolDenial('list_customers', { workspace_id: '  ' }, ['read:customers'], WS)).toBeNull();
  });
});
