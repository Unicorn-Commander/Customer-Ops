import { z } from 'zod';
import { User } from '@prisma/client';
import { QuotesService } from '../quotes/quotes.service';
import * as S from '../quotes/quote.schemas';
export function registerQuoteTools(server: any, user: User, quotes: QuotesService | undefined) {
  const mutations: Record<string, z.AnyZodObject> = {
    create_quote: S.quoteCreate,
    update_quote: S.quoteUpdate,
    add_quote_section: S.sectionInput,
    add_quote_line: S.lineInput,
    update_quote_line: S.lineUpdate,
    set_quote_options: S.optionsInput,
    set_quote_recipients: S.recipientsInput,
    add_quote_cost: S.costInput,
    add_quote_attachment: S.attachmentInput,
  };
  for (const name of [
    'list_quotes',
    'get_quote',
    'list_price_book',
    'remove_quote_line',
    ...Object.keys(mutations),
  ]) {
    const shape: any = { workspace_id: z.string().optional() };
    if (!['list_quotes', 'list_price_book', 'create_quote'].includes(name))
      shape.quote_id = z.string().uuid();
    if (['update_quote_line', 'remove_quote_line'].includes(name))
      shape.line_id = z.string().uuid();
    if (name === 'list_quotes') {
      shape.customerId = z.string().uuid().optional();
      shape.limit = z.number().int().min(1).max(100).optional();
    }
    if (mutations[name]) shape.data = mutations[name];
    server.registerTool(
      name,
      {
        title: name,
        description:
          'Workspace-scoped draft quote operation. Quotes must be enabled; never sends or accepts.',
        inputSchema: shape,
      },
      async (args: any) => {
        try {
          if (!quotes) throw Error('Quotes are not enabled');
          const result = await quotes.execute(user, args.workspace_id, name, args);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (e) {
          return {
            isError: true,
            content: [
              { type: 'text', text: e instanceof Error ? e.message : 'Quote operation failed' },
            ],
          };
        }
      },
    );
  }
}
