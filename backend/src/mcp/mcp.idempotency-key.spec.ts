import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { McpService } from './mcp.service';
import { IDEMPOTENCY_KEY_PATTERN } from '../common/idempotency-key';

/**
 * CUO-MCP-1: every MCP tool that takes an idempotency_key enforces the SAME
 * charset as the REST DTOs (^[A-Za-z0-9._:-]+$, max 200). A key the REST
 * surface refuses is refused over MCP too.
 */
describe('MCP idempotency_key charset matches the REST DTOs', () => {
  let schemas: Array<[string, z.ZodTypeAny]>;

  beforeAll(async () => {
    const register = jest
      .spyOn(McpServer.prototype, 'registerTool')
      .mockImplementation(() => ({}) as any);
    try {
      const stub = {} as any;
      const service = new McpService(stub, stub, stub, stub, stub, stub, stub, stub);
      await service.createServerForUser({ id: 'synthetic' } as any);
      schemas = register.mock.calls
        .filter(([, def]) => (def as any)?.inputSchema?.idempotency_key)
        .map(([name, def]) => [name as string, (def as any).inputSchema.idempotency_key]);
    } finally {
      register.mockRestore();
    }
  });

  it('covers the five keyed tools', () => {
    expect(schemas.length).toBeGreaterThanOrEqual(5);
  });

  it.each([
    'has space',
    'semi;colon',
    'slash/path',
    'emoji-\u{1F600}',
    'new\nline',
    '',
    'a'.repeat(201),
  ])('refuses the bad key %j on every keyed tool', (bad) => {
    for (const [name, schema] of schemas) {
      expect({ name, ok: schema.safeParse(bad).success }).toEqual({ name, ok: false });
    }
  });

  it('accepts a REST-valid key and an omitted key', () => {
    const good = 'retry:2026-11-23.invoice_1-a';
    expect(IDEMPOTENCY_KEY_PATTERN.test(good)).toBe(true);
    for (const [name, schema] of schemas) {
      expect({ name, ok: schema.safeParse(good).success }).toEqual({ name, ok: true });
      expect({ name, ok: schema.safeParse(undefined).success }).toEqual({ name, ok: true });
    }
  });
});
