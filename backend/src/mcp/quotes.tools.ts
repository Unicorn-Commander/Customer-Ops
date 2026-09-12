import { z } from 'zod';
import { User } from '@prisma/client';
import { QuotesService } from '../quotes/quotes.service';
import { QuoteDocumentService } from '../quotes/quote-document.service';
import { QuotesLifecycleService } from '../quotes/quotes-lifecycle.service';
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

export function registerQuoteLifecycleTools(
  server: any,
  user: User,
  lifecycle?: QuotesLifecycleService,
  documents?: QuoteDocumentService,
) {
  const definitions: Record<string, any> = {
    render_quote: { format: z.enum(['html', 'pdf']).default('html') },
    send_quote: { idempotency_key: z.string().min(1).max(200) },
    supersede_quote: {},
    revoke_share_link: { token_id: z.string().uuid() },
    record_quote_acceptance: {
      idempotency_key: z.string().min(1).max(200),
      data: z.object({
        name: z.string(),
        email: z.string().email(),
        title: z.string().nullable().optional(),
        when: z.string().datetime(),
        how: z.string(),
        selected_line_ids: z.array(z.string()),
      }),
    },
    list_quote_versions: {},
    list_quote_events: {},
  };
  for (const [name, fields] of Object.entries(definitions))
    server.registerTool(
      name,
      {
        title: name,
        description:
          'Workspace-scoped quote lifecycle. Sending creates an approval draft only; owner-recorded acceptance requires the owner role.',
        inputSchema: {
          workspace_id: z.string().optional(),
          quote_id: z.string().uuid(),
          ...fields,
        },
      },
      async (args: any) => {
        try {
          if (!lifecycle) throw Error('Quotes are not enabled');
          const result =
            name === 'render_quote'
              ? await documents?.render(user, args.workspace_id, args.quote_id, args.format)
              : name === 'send_quote'
                ? await lifecycle.send(user, args.workspace_id, args.quote_id, args.idempotency_key)
                : name === 'supersede_quote'
                  ? await lifecycle.supersede(user, args.workspace_id, args.quote_id)
                  : name === 'revoke_share_link'
                    ? await lifecycle.revoke(user, args.workspace_id, args.quote_id, args.token_id)
                    : name === 'record_quote_acceptance'
                      ? await lifecycle.recordAcceptance(
                          user,
                          args.workspace_id,
                          args.quote_id,
                          args.data,
                          args.idempotency_key,
                        )
                      : await lifecycle.history(
                          user,
                          args.workspace_id,
                          args.quote_id,
                          name === 'list_quote_versions' ? 'versions' : 'events',
                        );
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
