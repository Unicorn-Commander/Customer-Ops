import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_TOOL_NO_SCOPE, MCP_TOOL_SCOPE_MAP } from '../auth/pat/pat.constants';
import { McpService } from './mcp.service';
import { mcpAnnotationsFor } from './mcp-annotations';

/**
 * F3 BYO-AI: the MCP tool annotations (readOnlyHint / destructiveHint /
 * openWorldHint) that let web ChatGPT + Claude decide which tool calls need a
 * confirmation click. The read/write truth comes from MCP_TOOL_SCOPE_MAP;
 * mcpAnnotationsFor projects it onto the MCP annotation schema, and McpService
 * stamps every registered tool (including the quote tools) with the result.
 */
describe('mcpAnnotationsFor — pure cases', () => {
  it('a read tool is readOnly, non-destructive, closed-world', () => {
    expect(mcpAnnotationsFor('list_customers', 'read:*')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('a write tool is not readOnly and not open-world', () => {
    expect(mcpAnnotationsFor('update_customer', 'write:*')).toEqual({
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

  it('send_quote (mails a customer) is open-world', () => {
    expect(mcpAnnotationsFor('send_quote', 'write:*')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('send_customer_email (mails a customer) is open-world', () => {
    expect(mcpAnnotationsFor('send_customer_email', 'write:*')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it('a non-send write tool is NOT open-world', () => {
    expect(mcpAnnotationsFor('create_customer_invoice', 'write:*')?.openWorldHint).toBe(false);
  });

  it('a run:agents tool (DRAFT-ONLY) is read-only', () => {
    expect(mcpAnnotationsFor('triage_customer', 'run:agents')).toEqual({
      readOnlyHint: true,
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
