import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkspaceRole } from '@prisma/client';
import { MCP_TOOL_MIN_ROLE, mcpRoleDenial, mcpRoleDenialFor, mcpToolDenial, mcpToolMinRole } from './mcp-access';
import { MCP_TOOL_SCOPE_MAP } from '../auth/pat/pat.constants';
import { roleMeetsMinimum } from '../common/workspace/workspace-role.util';
import { McpService } from './mcp.service';

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
    // The PAT scope gate itself still lets an unmapped name through for a
    // non-PAT caller; the DENY-BY-DEFAULT role gate (mcpRoleDenialFor /
    // McpService.enforceToolRole) is what refuses it — see the role-RBAC block.
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

describe('MCP_TOOL_MIN_ROLE — the role registry', () => {
  it('every entry is at least VIEWER; every write/agent tool is at least MEMBER', () => {
    for (const role of Object.values(MCP_TOOL_MIN_ROLE)) {
      expect(Object.values(WorkspaceRole)).toContain(role);
    }
    for (const [tool, scope] of Object.entries(MCP_TOOL_SCOPE_MAP)) {
      if (scope.startsWith('write:') || scope === 'run:agents') {
        // A MUTATING tool must gate at MEMBER or above — never viewer-level.
        expect(roleMeetsMinimum(MCP_TOOL_MIN_ROLE[tool], WorkspaceRole.MEMBER)).toBe(true);
      }
    }
  });

  it('a mutating tool is mapped at MEMBER+ and a read tool at exactly VIEWER', () => {
    // Keeps the two maps in lock-step so a new mutation tool cannot slip past
    // the role gate and a new read tool cannot be forgotten from the registry.
    for (const [tool, scope] of Object.entries(MCP_TOOL_SCOPE_MAP)) {
      const mutates = scope.startsWith('write:') || scope === 'run:agents';
      expect(MCP_TOOL_MIN_ROLE[tool]).toBeDefined();
      expect(MCP_TOOL_MIN_ROLE[tool] === WorkspaceRole.VIEWER).toBe(!mutates);
    }
    // render_quote is a read with NO PAT scope entry; it is still mapped (VIEWER)
    // so the role registry stays total over the registered roster.
    expect(MCP_TOOL_MIN_ROLE['render_quote']).toBe(WorkspaceRole.VIEWER);
  });

  it('a read tool carries an explicit VIEWER minimum (distinguishable from "forgotten")', () => {
    expect(mcpToolMinRole('list_customers')).toBe(WorkspaceRole.VIEWER);
    expect(mcpToolMinRole('get_customer_360')).toBe(WorkspaceRole.VIEWER);
    expect(mcpToolMinRole('health')).toBe(WorkspaceRole.VIEWER);
    expect(mcpToolMinRole('list_my_workspaces')).toBe(WorkspaceRole.VIEWER);
  });

  it('every REGISTERED MCP tool has a MCP_TOOL_MIN_ROLE entry (deny-by-default roster)', () => {
    // The live enforcement registry (MCP_TOOL_MIN_ROLE) must cover every tool
    // McpService.createServerForUser registers, so a NEW tool cannot be shipped
    // without a role decision. A registration forgotten from the registry is
    // refused for every caller (mcpRoleDenialFor) — this test is what catches
    // the forgetting at the head. Quotes registration is gated on the optional
    // QuotesService being present; pass a live stub so the quote tools register.
    const register = jest
      .spyOn(McpServer.prototype, 'registerTool')
      .mockImplementation(() => ({} as any));
    try {
      const stub = {} as any;
      const service = new McpService(
        stub,
        stub,
        stub,
        stub,
        stub,
        stub,
        stub,
        stub,
        { execute: async () => ({}) } as any,
      );
      void service.createServerForUser({ id: 'synthetic' } as any);
      const registered = register.mock.calls.map(([name]) => String(name));
      expect(registered.length).toBeGreaterThanOrEqual(35);
      const missing = registered.filter((name) => !(name in MCP_TOOL_MIN_ROLE));
      expect(missing).toEqual([]);
    } finally {
      register.mockRestore();
    }
  });
});

describe('mcpRoleDenial — workspace role RBAC on MCP tools', () => {
  it('403s a VIEWER on every mutation + agent-run tool', () => {
    for (const [tool, required] of Object.entries(MCP_TOOL_MIN_ROLE)) {
      if (required === WorkspaceRole.VIEWER) continue; // read tools: pinned below
      const denial = mcpRoleDenial(tool, WorkspaceRole.VIEWER);
      const detail = detailOf(denial);
      expect(detail.error).toBe('role_denied');
      expect(detail.tool).toBe(tool);
      expect(detail.required_role).toBe(required.toLowerCase());
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

  it('allows every mapped viewer-level read tool for a VIEWER, and still fails a null role', () => {
    // The live registry carries the read tools at an EXPLICIT VIEWER minimum
    // (so a read tool is distinguishable from a forgotten entry, which the
    // gate below refuses for every caller). A VIEWER and any member pass; a
    // null role (non-member) is refused, fail closed.
    for (const tool of [
      'list_customers',
      'get_customer_360',
      'pipeline_board',
      'health',
      'list_my_workspaces',
      'list_quotes',
      'list_quote_versions',
    ]) {
      expect(mcpRoleDenial(tool, WorkspaceRole.VIEWER)).toBeNull();
      expect(mcpRoleDenial(tool, WorkspaceRole.OWNER)).toBeNull();
    }
    const detail = detailOf(mcpRoleDenial('list_customers', null));
    expect(detail.error).toBe('role_denied');
    expect(detail.required_role).toBe('viewer');
    expect(detail.your_role).toBeNull();
  });

  it('DENIES an unmapped tool for every role, in the role-refusal shape (deny-by-default)', () => {
    // A NEW mutation tool forgotten from MCP_TOOL_MIN_ROLE must not slip past
    // the gate at viewer level: null, VIEWER, MEMBER and OWNER are all refused,
    // and the envelope carries the SAME shape as a role refusal.
    for (const role of [null, WorkspaceRole.VIEWER, WorkspaceRole.MEMBER, WorkspaceRole.OWNER]) {
      const denial = mcpRoleDenial('a_brand_new_mutation_tool', role);
      const detail = detailOf(denial);
      expect(detail.error).toBe('role_denied');
      expect(detail.tool).toBe('a_brand_new_mutation_tool');
      expect(detail.required_role).toContain('unmapped tool');
      expect(detail.your_role).toBeNull();
    }
  });

  it('the deny-by-default is what the registry carries, not the tool name (fake-registry proof)', () => {
    // Same function, a fixture registry: a mapped tool is gated by its entry
    // (MEMBER refuses a VIEWER) and a tool ABSENT from the fixture is refused
    // even for an OWNER. If the refusal were keyed on the tool name instead of
    // the missing entry, these two assertions could not both hold.
    const fake: Record<string, WorkspaceRole> = { only_tool: WorkspaceRole.MEMBER };
    const viewerDetail = detailOf(mcpRoleDenialFor('only_tool', WorkspaceRole.VIEWER, fake));
    expect(viewerDetail.error).toBe('role_denied');
    expect(viewerDetail.required_role).toBe('member');
    const unmappedDetail = detailOf(mcpRoleDenialFor('ghost_tool', WorkspaceRole.OWNER, fake));
    expect(unmappedDetail.error).toBe('role_denied');
    expect(unmappedDetail.required_role).toContain('unmapped tool');
    // And a mapped tool the caller satisfies is allowed — the refusal is not a blanket block.
    expect(mcpRoleDenialFor('only_tool', WorkspaceRole.MEMBER, fake)).toBeNull();
  });
});
