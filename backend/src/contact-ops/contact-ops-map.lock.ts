import { Prisma } from '@prisma/client';

/**
 * The one per-workspace lock every writer of a `contact-ops` map row takes
 * (R5-1): provisioning's insert, the conflict mark, the owner connection route
 * and backfill --apply. Transaction-scoped: taken before the row is read, held
 * until commit, so no writer acts on a row another writer is changing.
 */
export async function lockContactOpsRow(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId + ':contact-ops'}))`;
}
