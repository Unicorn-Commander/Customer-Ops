import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_TOOL_NO_SCOPE, MCP_TOOL_SCOPE_MAP } from '../auth/pat/pat.constants';
import { McpService } from './mcp.service';
import {
  ADDITIVE_WRITE_TOOLS,
  AGENT_WRITE_TOOLS,
  mcpAnnotationsFor,
  OPEN_WORLD_TOOLS,
} from './mcp-annotations';

/**
 * F3 BYO-AI (F3-CUO-2): the MCP tool annotations (readOnlyHint /
 * destructiveHint / openWorldHint) that let web ChatGPT + Claude decide which
 * tool calls need a confirmation click. The read/write truth comes from
 * MCP_TOOL_SCOPE_MAP; mcpAnnotationsFor projects it onto the MCP annotation
 * schema (a write:* tool is destructive unless it only ADDS rows — the
 * ADDITIVE_WRITE_TOOLS set — and openWorld when it delivers outside the
 * workspace — the OPEN_WORLD_TOOLS set; a run:agents tool is a non-destructive
 * write because its agent logs an AGENT_RUN row and may stage a draft), and
 * McpService stamps every registered tool (including the quote tools) with the
 * result.
 */
describe('mcpAnnotationsFor — pure cases', () => {
  it('a read tool is readOnly, non-destructive, closed-world', () => {
    expect(mcpAnnotationsFor('list_customers', 'read:*')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('a destructive write tool (update_*) is not readOnly', () => {
    expect(mcpAnnotationsFor('update_quote', 'write:*')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it('an additive write tool (create_*) is not destructive', () => {
    expect(mcpAnnotationsFor('create_quote', 'write:*')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('a remove_ tool is destructive', () => {
    expect(mcpAnnotationsFor('remove_quote_line', 'write:*')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it('send_quote (stages a customer email in Email-Ops) is open-world', () => {
    expect(mcpAnnotationsFor('send_quote', 'write:*')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it('send_customer_email (sends mail to a person) is open-world + destructive (mode=send is the default)', () => {
    expect(mcpAnnotationsFor('send_customer_email', 'write:*')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it('a write tool that is in NEITHER set is destructive + closed-world', () => {
    expect(mcpAnnotationsFor('transition_customer_stage', 'write:*')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it('a run:agents tool (logs an AGENT_RUN row; the drafters may stage a draft) is a non-destructive write', () => {
    expect(mcpAnnotationsFor('triage_customer', 'run:agents')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(mcpAnnotationsFor('draft_followup', 'run:agents')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(mcpAnnotationsFor('draft_collections_nudge', 'run:agents')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('a scope-exempt tool (health) is read-only', () => {
    expect(mcpAnnotationsFor('health', undefined)).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('a scope-exempt tool (list_my_workspaces) is read-only', () => {
    expect(mcpAnnotationsFor('list_my_workspaces', undefined)).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('a tool with NO scope and not scope-exempt gets NO annotations (do not guess)', () => {
    expect(mcpAnnotationsFor('a_totally_unmapped_tool', undefined)).toBeUndefined();
    expect(mcpAnnotationsFor('a_totally_unmapped_tool', 'bogus:*')).toBeUndefined();
    // a run:agents tool forgotten from AGENT_WRITE_TOOLS fails closed too:
    expect(mcpAnnotationsFor('a_new_agent_forgotten_from_the_set', 'run:agents')).toBeUndefined();
  });

  it('existing config.annotations win (spread last)', () => {
    expect(
      mcpAnnotationsFor('send_quote', 'write:*', { destructiveHint: true, openWorldHint: false }),
    ).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  });
});

describe('McpService — every registered tool carries annotations', () => {
  it('ZERO registered tools lack annotations; read + write + no-scope = total', async () => {
    const sdk = require('@modelcontextprotocol/sdk/server/mcp.js');
    const realRegister = sdk.McpServer.prototype.registerTool;
    const seen: { name: string; annotations: unknown }[] = [];

    let read = 0;
    let write = 0;
    let runAgents = 0;
    for (const [name, scope] of Object.entries(MCP_TOOL_SCOPE_MAP)) {
      if (scope.startsWith('read:')) read += 1;
      else if (scope === 'run:agents') runAgents += 1;
      else write += 1;
    }
    const noScope = MCP_TOOL_NO_SCOPE.size;

    // Build McpService the way mcp-access.spec.ts does: stub services, a live
    // QuotesService stub so the quote tools register, then read back what the
    // SDK actually stored per tool.
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
      {} as any,
      {} as any,
    );
    const server = (await service.createServerForUser({ id: 'synthetic' } as any)) as any;
    const registered = (server._registeredTools ?? {}) as Record<string, any>;
    const names = Object.keys(registered);

    expect(names.length).toBeGreaterThanOrEqual(35);
    for (const name of names) seen.push({ name, annotations: registered[name].annotations });
    const missing = seen.filter((t) => t.annotations === undefined);
    expect(missing).toEqual([]);

    const scopeOf = (n: string) => MCP_TOOL_SCOPE_MAP[n];
    const noScopeNames = new Set(MCP_TOOL_NO_SCOPE);
    let readOnly = 0;
    let writeTools = 0;
    let runAgentsSeen = 0;
    let noScopeSeen = 0;
    for (const name of names) {
      const s = scopeOf(name);
      if (noScopeNames.has(name)) noScopeSeen += 1;
      else if (s?.startsWith('read:')) readOnly += 1;
      else if (s === 'run:agents') runAgentsSeen += 1;
      else writeTools += 1;
    }
    expect(readOnly).toBe(read);
    expect(writeTools).toBe(write);
    expect(runAgentsSeen).toBe(runAgents);
    expect(noScopeSeen).toBe(noScope);
    expect(names.length).toBe(read + write + runAgents + noScope);

    const total = names.length;
    // eslint-disable-next-line no-console
    console.log(
      `mcp-annotations: read=${read} write=${write} run-agents=${runAgents} no-scope=${noScope} total=${total} (sum check: ${
        read + write + runAgents + noScope === total
      })`,
    );
  });
});

describe('McpService — the FULL annotation surface (F3-CUO-2)', () => {
  async function registeredTools(): Promise<Record<string, any>> {
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
      {} as any,
      {} as any,
    );
    const server = (await service.createServerForUser({ id: 'synthetic' } as any)) as any;
    return (server._registeredTools ?? {}) as Record<string, any>;
  }

  it('EVERY registered tool matches the scope-derived rule (per tool)', async () => {
    const registered = await registeredTools();
    const names = Object.keys(registered);
    expect(names.length).toBeGreaterThanOrEqual(35);
    let read = 0;
    let additive = 0;
    let destructive = 0;
    let agents = 0;
    for (const name of names) {
      const a = registered[name].annotations;
      expect(a).toBeDefined();
      const scope = MCP_TOOL_SCOPE_MAP[name];
      if (MCP_TOOL_NO_SCOPE.has(name) || scope?.startsWith('read:')) {
        read += 1;
        expect(a).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      } else if (scope?.startsWith('write:')) {
        if (ADDITIVE_WRITE_TOOLS.has(name)) additive += 1;
        else destructive += 1;
        expect(a).toEqual({
          readOnlyHint: false,
          destructiveHint: !ADDITIVE_WRITE_TOOLS.has(name),
          openWorldHint: OPEN_WORLD_TOOLS.has(name),
        });
      } else if (scope === 'run:agents') {
        agents += 1;
        expect(a).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
      } else {
        throw new Error(`registered tool "${name}" has no scope mapping — cannot annotate it`);
      }
    }
    const total = names.length;
    // eslint-disable-next-line no-console
    console.log(
      `mcp-annotations (surface): read=${read} additive-write=${additive} destructive-write=${destructive} run-agents=${agents} total=${total} (sum check: ${
        read + additive + destructive + agents === total
      })`,
    );
    expect(read + additive + destructive + agents).toBe(total);
  });

  it('named cases: the open-world tools, the additive tools, the destructive writes', async () => {
    const registered = await registeredTools();
    const of = (n: string) => registered[n]?.annotations;
    // open-world: each delivers to a party outside the workspace (REPORT.md).
    for (const n of [
      'send_quote',
      'send_customer_email',
      'start_customer_campaign',
      'create_customer_invoice',
      'record_quote_acceptance',
      'ingest_lead',
    ]) {
      expect(of(n)?.openWorldHint).toBe(true);
      expect(of(n)?.readOnlyHint).toBe(false);
    }
    // additive writes: they only add rows (REPORT.md) — never destructive.
    for (const n of [
      'create_quote',
      'add_quote_section',
      'add_quote_line',
      'add_quote_cost',
      'add_quote_attachment',
      'add_customer_note',
      'create_customer_invoice',
      'record_quote_acceptance',
      'record_customer_engagement',
    ]) {
      expect(of(n)?.destructiveHint).toBe(false);
    }
    // destructive writes: they overwrite or delete existing data (REPORT.md).
    for (const n of [
      'update_quote',
      'update_quote_line',
      'set_quote_options',
      'set_quote_recipients',
      'remove_quote_line',
      'update_customer',
      'transition_customer_stage',
      'mark_customer_lost',
      'supersede_quote',
      'revoke_share_link',
      'resolve_pending_leads',
      'discard_lead_intake',
      'send_quote',
      'send_customer_email',
      'start_customer_campaign',
    ]) {
      expect(of(n)?.destructiveHint).toBe(true);
    }
    // the run:agents tools: non-destructive writes, closed-world.
    for (const n of ['triage_customer', 'draft_followup', 'draft_collections_nudge']) {
      expect(of(n)).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    }
    // the scope-exempt tools: read-only.
    for (const n of ['health', 'list_my_workspaces']) {
      expect(of(n)).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
  });

  it('every name in ADDITIVE_WRITE_TOOLS / OPEN_WORLD_TOOLS / AGENT_WRITE_TOOLS is a registered tool (a typo fails)', async () => {
    const registered = await registeredTools();
    for (const n of [...ADDITIVE_WRITE_TOOLS, ...OPEN_WORLD_TOOLS, ...AGENT_WRITE_TOOLS]) {
      expect({ set: n, registered: Boolean(registered[n]) }).toEqual({
        set: n,
        registered: true,
      });
      expect(MCP_TOOL_SCOPE_MAP[n]).toBeDefined();
    }
    // and the sets agree with the scope map: additive + open-world are write:* tools,
    // the agent set is exactly the run:agents tools.
    for (const n of [...ADDITIVE_WRITE_TOOLS, ...OPEN_WORLD_TOOLS]) {
      expect(MCP_TOOL_SCOPE_MAP[n]).toMatch(/^write:/);
    }
    for (const n of AGENT_WRITE_TOOLS) expect(MCP_TOOL_SCOPE_MAP[n]).toBe('run:agents');
    const runAgentsInMap = Object.keys(MCP_TOOL_SCOPE_MAP).filter(
      (n) => MCP_TOOL_SCOPE_MAP[n] === 'run:agents',
    );
    expect(runAgentsInMap.sort()).toEqual([...AGENT_WRITE_TOOLS].sort());
  });
});
