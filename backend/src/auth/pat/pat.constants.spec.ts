import {
  MCP_TOOL_NO_SCOPE,
  MCP_TOOL_SCOPE_MAP,
  PAT_AVAILABLE_SCOPES,
  SCOPE_IMPLICATIONS,
  expandScopes,
} from './pat.constants';

/**
 * Every MCP tool registered in mcp.service.ts. The scope gate fails CLOSED on an
 * unmapped tool, so this list is the contract: a tool added to the server MUST
 * also land in MCP_TOOL_SCOPE_MAP or MCP_TOOL_NO_SCOPE, or PAT callers can't use
 * it. Keep in lock-step with mcp.service.ts (the test below enforces it both ways).
 */
const REGISTERED_MCP_TOOLS = [
  'create_quote',
  'update_quote',
  'add_quote_section',
  'add_quote_line',
  'update_quote_line',
  'remove_quote_line',
  'set_quote_options',
  'set_quote_recipients',
  'add_quote_cost',
  'add_quote_attachment',
  'list_quotes',
  'get_quote',
  'list_price_book',
  'health',
  'list_my_workspaces',
  'list_customers',
  'get_customer_360',
  'pipeline_board',
  'transition_customer_stage',
  'add_customer_note',
  'list_customer_invoices',
  'create_customer_invoice',
  'list_customer_outreach',
  'start_customer_campaign',
  'list_customer_email',
  'send_customer_email',
  'record_customer_engagement',
  'list_customer_meetings',
  'triage_customer',
  'draft_followup',
  'draft_collections_nudge',
  'ingest_lead',
  'lead_intake_stats',
  'list_lead_intakes',
  'resolve_pending_leads',
  'discard_lead_intake',
];

describe('expandScopes (write ⊇ read implication)', () => {
  it('adds the implied read for each write scope', () => {
    expect(expandScopes(['write:customers']).has('read:customers')).toBe(true);
    expect(expandScopes(['write:activity']).has('read:activity')).toBe(true);
    expect(expandScopes(['write:leads']).has('read:leads')).toBe(true);
    expect(expandScopes(['write:quotes']).has('read:quotes')).toBe(true);
  });

  it('keeps the originally-granted scopes', () => {
    const set = expandScopes(['write:customers', 'run:agents']);
    expect(set.has('write:customers')).toBe(true);
    expect(set.has('run:agents')).toBe(true);
  });

  it('does NOT invent unrelated scopes (read does not imply write)', () => {
    const set = expandScopes(['read:customers']);
    expect(set.has('write:customers')).toBe(false);
    expect([...set]).toEqual(['read:customers']);
  });

  it('treats read:overview and run:agents as standalone (no implications)', () => {
    expect([...expandScopes(['read:overview'])]).toEqual(['read:overview']);
    expect([...expandScopes(['run:agents'])]).toEqual(['run:agents']);
  });

  it('is empty for an empty grant', () => {
    expect(expandScopes([]).size).toBe(0);
  });
});

describe('SCOPE_IMPLICATIONS integrity', () => {
  it('only maps real scopes to real scopes', () => {
    const valid = new Set<string>(PAT_AVAILABLE_SCOPES);
    for (const [from, tos] of Object.entries(SCOPE_IMPLICATIONS)) {
      expect(valid.has(from)).toBe(true);
      for (const to of tos) expect(valid.has(to)).toBe(true);
    }
  });
});

describe('MCP scope map ↔ registered tools (fail-closed coverage)', () => {
  it('maps every scoped tool to a real PAT scope', () => {
    const valid = new Set<string>(PAT_AVAILABLE_SCOPES);
    for (const scope of Object.values(MCP_TOOL_SCOPE_MAP)) {
      expect(valid.has(scope)).toBe(true);
    }
  });

  it('covers EVERY registered tool (each is scoped or explicitly exempt)', () => {
    for (const tool of REGISTERED_MCP_TOOLS) {
      const covered = tool in MCP_TOOL_SCOPE_MAP || MCP_TOOL_NO_SCOPE.has(tool);
      expect(covered).toBe(true);
    }
  });

  it('does not map a tool that is also marked no-scope (no ambiguity)', () => {
    for (const tool of MCP_TOOL_NO_SCOPE) {
      expect(tool in MCP_TOOL_SCOPE_MAP).toBe(false);
    }
  });

  it('does not reference a tool that is not actually registered (no map drift)', () => {
    const registered = new Set(REGISTERED_MCP_TOOLS);
    for (const tool of Object.keys(MCP_TOOL_SCOPE_MAP)) expect(registered.has(tool)).toBe(true);
    for (const tool of MCP_TOOL_NO_SCOPE) expect(registered.has(tool)).toBe(true);
  });

  it('exempts only health + identity (never a data-mutating tool)', () => {
    expect([...MCP_TOOL_NO_SCOPE].sort()).toEqual(['health', 'list_my_workspaces']);
  });
});
