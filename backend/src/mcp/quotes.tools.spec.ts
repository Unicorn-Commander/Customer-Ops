import { registerQuoteTools } from './quotes.tools';
import { mcpToolDenial, mcpToolMinRole } from './mcp-access';
import { WorkspaceRole } from '@prisma/client';
describe('quote MCP registration and policy', () => {
  const server = () => {
    const handlers = new Map<string, any>();
    return {
      handlers,
      registerTool: (name: string, _: any, handler: any) => handlers.set(name, handler),
    };
  };
  it('all tools are mapped and writers require membership', () => {
    const s = server();
    registerQuoteTools(s, {} as any, undefined);
    expect(s.handlers.size).toBe(13);
    for (const name of s.handlers.keys()) {
      const read = ['get_quote', 'list_quotes', 'list_price_book'].includes(name);
      expect(
        mcpToolDenial(name, { workspace_id: 'a' }, [read ? 'read:quotes' : 'write:quotes'], 'a'),
      ).toBeNull();
      expect(mcpToolDenial(name, { workspace_id: 'b' }, ['write:quotes'], 'a')).not.toBeNull();
      expect(mcpToolDenial(name, { workspace_id: 'a' }, [], 'a')).not.toBeNull();
      if (!read) expect(mcpToolMinRole(name)).toBe(WorkspaceRole.MEMBER);
    }
  });
  it('disabled tools return a clear error and share the service implementation', async () => {
    const s = server();
    registerQuoteTools(s, {} as any, undefined);
    expect((await s.handlers.get('create_quote')({})).isError).toBe(true);
    const execute = jest.fn().mockResolvedValue({ number: 'Q-fixture' });
    const live = server();
    const user = {} as any;
    registerQuoteTools(live, user, { execute } as any);
    const args = { workspace_id: 'a', quote_id: 'fixture' };
    const result = await live.handlers.get('get_quote')(args);
    expect(execute).toHaveBeenCalledWith(user, 'a', 'get_quote', args);
    expect(JSON.parse(result.content[0].text).number).toBe('Q-fixture');
  });
});
