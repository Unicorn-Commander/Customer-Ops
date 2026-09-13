import 'reflect-metadata';
import { QuotesController } from './quotes.controller';
import { REQUIRE_SCOPES_KEY } from '../auth/decorators/require-scopes.decorator';
import { REQUIRE_WORKSPACE_ROLE_KEY } from '../auth/decorators/require-workspace-role.decorator';
import { WorkspaceRole } from '@prisma/client';
it('every REST mutation has both write scope and member role metadata', () => {
  for (const name of [
    'create',
    'update',
    'section',
    'line',
    'updateLine',
    'removeLine',
    'options',
    'recipients',
    'cost',
    'attachment',
  ]) {
    const handler = (QuotesController.prototype as any)[name];
    expect(Reflect.getMetadata(REQUIRE_SCOPES_KEY, handler)).toEqual(['write:quotes']);
    expect(Reflect.getMetadata(REQUIRE_WORKSPACE_ROLE_KEY, handler)).toBe(WorkspaceRole.MEMBER);
  }
  for (const name of ['list', 'get', 'priceBook'])
    expect(
      Reflect.getMetadata(REQUIRE_SCOPES_KEY, (QuotesController.prototype as any)[name]),
    ).toEqual(['read:quotes']);
});
