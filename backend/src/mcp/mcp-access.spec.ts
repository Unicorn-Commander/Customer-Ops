import { WorkspaceRole } from '@prisma/client';
import { MCP_TOOL_MIN_ROLE, mcpRoleDenial, mcpToolDenial, mcpToolMinRole } from './mcp-access';
import { MCP_TOOL_SCOPE_MAP } from '../auth/pat/pat.constants';

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
    expect(
      mcpToolDenial('transition_customer_stage', { workspace_id: OTHER_WS }, null, null),
    ).toBeNull();
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
    expect(
      mcpToolDenial('list_customers', { workspace_id: WS }, ['read:customers'], WS),
    ).toBeNull();
  });

  it('allows omitting workspace_id (falls back to the bound workspace)', () => {
    expect(mcpToolDenial('list_customers', {}, ['read:customers'], WS)).toBeNull();
  });

  it('DENIES an arg workspace_id that escapes the PAT binding', () => {
    const denial = mcpToolDenial(
      'list_customers',
      { workspace_id: OTHER_WS },
      ['read:customers'],
      WS,
    );
    const detail = detailOf(denial);
    expect(detail.error).toBe('workspace_denied');
    expect(detail.pat_workspace).toBe(WS);
    expect(detail.requested_workspace).toBe(OTHER_WS);
  });

  it('checks the workspace fence BEFORE the scope (a cross-ws read is still denied)', () => {
    // Even with the right scope, a cross-workspace arg is refused.
    const denial = mcpToolDenial(
      'list_customers',
      { workspace_id: OTHER_WS },
      ['read:customers'],
      WS,
    );
    expect(detailOf(denial).error).toBe('workspace_denied');
  });

  it('ignores a blank/whitespace workspace_id arg', () => {
    expect(
      mcpToolDenial('list_customers', { workspace_id: '  ' }, ['read:customers'], WS),
    ).toBeNull();
  });
});

describe('MCP_TOOL_MIN_ROLE — the mutation roster', () => {
  it('every write/agent tool requires at least MEMBER (a viewer cannot mutate)', () => {
    for (const role of Object.values(MCP_TOOL_MIN_ROLE)) {
      expect([WorkspaceRole.MEMBER, WorkspaceRole.OWNER]).toContain(role);
    }
  });

  it('the role-gated set is exactly the write/agent scopes — read tools stay viewer-level', () => {
    // A tool that MUTATES (write:* / run:agents in the PAT scope map) must carry a
    // minimum role; a read:* tool must NOT. Keeps the two maps in lock-step so a
    // new mutation tool can't slip past the role gate.
    for (const [tool, scope] of Object.entries(MCP_TOOL_SCOPE_MAP)) {
      const mutates = scope.startsWith('write:') || scope === 'run:agents';
      expect(Boolean(mcpToolMinRole(tool))).toBe(mutates);
    }
  });

  it('an unmapped / read tool has no minimum role (null)', () => {
    expect(mcpToolMinRole('list_customers')).toBeNull();
    expect(mcpToolMinRole('get_customer_360')).toBeNull();
    expect(mcpToolMinRole('health')).toBeNull();
    expect(mcpToolMinRole('list_my_workspaces')).toBeNull();
    expect(mcpToolMinRole('not_a_real_tool')).toBeNull();
  });
});

describe('mcpRoleDenial — workspace role RBAC on MCP tools', () => {
  it('403s a VIEWER on every mutation + agent-run tool', () => {
    for (const tool of Object.keys(MCP_TOOL_MIN_ROLE)) {
      const denial = mcpRoleDenial(tool, WorkspaceRole.VIEWER);
      const detail = detailOf(denial);
      expect(detail.error).toBe('role_denied');
      expect(detail.tool).toBe(tool);
      expect(detail.required_role).toBe(MCP_TOOL_MIN_ROLE[tool].toLowerCase());
      expect(detail.your_role).toBe('viewer');
    }
  });

  it('403s a null-role (non-member) on a mutation tool — fail closed', () => {
    const detail = detailOf(mcpRoleDenial('transition_customer_stage', null));
    expect(detail.error).toBe('role_denied');
    expect(detail.your_role).toBeNull();
  });

  it('allows a MEMBER on mutation + agent-run tools', () => {
    expect(mcpRoleDenial('transition_customer_stage', WorkspaceRole.MEMBER)).toBeNull();
    expect(mcpRoleDenial('send_customer_email', WorkspaceRole.MEMBER)).toBeNull();
    expect(mcpRoleDenial('triage_customer', WorkspaceRole.MEMBER)).toBeNull();
    expect(mcpRoleDenial('ingest_lead', WorkspaceRole.MEMBER)).toBeNull();
  });

  it('allows an OWNER on mutation tools (higher role satisfies the minimum)', () => {
    expect(mcpRoleDenial('transition_customer_stage', WorkspaceRole.OWNER)).toBeNull();
  });

  it('never gates a viewer-level read tool, regardless of role (incl. a VIEWER)', () => {
    expect(mcpRoleDenial('list_customers', WorkspaceRole.VIEWER)).toBeNull();
    expect(mcpRoleDenial('get_customer_360', WorkspaceRole.VIEWER)).toBeNull();
    expect(mcpRoleDenial('health', null)).toBeNull();
    expect(mcpRoleDenial('list_my_workspaces', WorkspaceRole.VIEWER)).toBeNull();
  });
});
