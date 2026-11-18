/**
 * Management command: write the contact-ops map for EXISTING workspaces from
 * Contact-Ops' org lookup (C4; the backfill itself is Kit's, DESK-189).
 *
 *   node dist/contact-ops/contact-ops-map.backfill.js            # dry run
 *   node dist/contact-ops/contact-ops-map.backfill.js --apply    # write rows
 *
 * Dry run (the default) prints the org id -> tenant id pairs the lookup answers
 * and writes nothing. `--apply` writes each missing row by the provisioning rule
 * (ContactOpsMapProvisioner): only the lookup's tenant for THAT org id, never
 * over an existing row. Safe to run again. Not an HTTP route.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { ContactOpsMapModule } from './contact-ops-map.module';
import {
  ContactOpsMapBackfillReport,
  ContactOpsMapProvisioner,
} from './contact-ops-map.provisioner';

export function parseBackfillArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else throw new Error(`Unknown argument ${arg}; the only flag is --apply`);
  }
  return { apply };
}

export function formatBackfill(report: ContactOpsMapBackfillReport): string {
  if (report.dormant) {
    return (
      'Contact-Ops org lookup is DORMANT (CONTACT_OPS_BASE_URL / CONTACT_OPS_LOOKUP_CLIENT_ID / ' +
      'CONTACT_OPS_LOOKUP_CLIENT_SECRET / CONTACT_OPS_LOOKUP_TOKEN_URL not all set); nothing asked, nothing written.'
    );
  }
  const lines = [
    report.apply ? 'APPLY: writing missing contact-ops map rows' : 'DRY RUN: nothing is written',
  ];
  for (const p of report.pairs) lines.push(`${p.orgId} -> ${p.tenantId}`);
  for (const s of report.skipped) lines.push(`${s.orgId} skipped: ${s.reason}`);
  lines.push(
    `${report.pairs.length} pair(s), ${report.skipped.length} skipped, ${report.written} written`,
  );
  return lines.join('\n');
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, ContactOpsMapModule],
})
class ContactOpsMapBackfillModule {}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(ContactOpsMapBackfillModule, {
    logger: ['error', 'warn'],
  });
  try {
    const report = await app.get(ContactOpsMapProvisioner).backfill(args);
    console.log(formatBackfill(report));
    if (report.dormant) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
