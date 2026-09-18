import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { McpService } from './mcp.service';

it('advertises and retains structured names in the registered ingest schema', async () => {
  const register = jest.spyOn(McpServer.prototype, 'registerTool').mockImplementation(() => ({} as any));
  try {
    const stub = {} as any;
    const service = new McpService(stub, stub, stub, stub, stub, stub, stub, stub);
    await service.createServerForUser({ id: 'synthetic' } as any);
    const call = register.mock.calls.find(([name]) => name === 'ingest_lead');
    expect(call).toBeDefined();
    const schema = z.object((call![1] as any).inputSchema);
    const input = { source: 'synthetic', source_dedup_key: 'test', given_name: 'Synthetic', family_name: 'Contact', nicknames: ['Example'] };
    expect(schema.parse(input)).toEqual(input);
    expect(schema.safeParse({ ...input, nicknames: Array(11).fill('Example') }).success).toBe(false);
  } finally {
    register.mockRestore();
  }
});
